const axios = require("axios");
const pLimit = require("p-limit");
const logger = require("../logger");
const {CrawlerSource, RawDocument, TrainingSample} = require("../db/models");

class BaseCrawler {
    /**
     * @param {object} options
     * @param {number} options.delayMs       - ms to wait between requests
     * @param {number} options.concurrency   - parallel requests
     * @param {boolean} options.skipIfCrawled - skip refs already marked SUCCESS
     */
    constructor(options) {
        this.delayMs = options.delayMs ?? 500;
        this.concurrency = options.concurrency ?? 1;
        this.skipIfCrawled = options.skipIfCrawled ?? true;
    }

    get name() {
        throw new Error(`${this.constructor.name} must implement get name()`);

    }

    async getWorkItems() {
        throw new Error(`${this.constructor.name} must implement getWorkItems()`);
    }

    async processItem(item) {
        throw new Error(`${this.constructor.name} must implement processItem()`);
    }

    async fetch(url, config = {}) {
        return axios.get(url, {
            timeout: 30_000,
            headers: {
                'User-Agent': process.env.CRAWLER_USER_AGENT || 'DugaCrawler/1.0 gabriel@companio.ee',
                ...config.headers,
            },
            ...config,
        });
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async _alreadyCrawled(ref) {
        const doc = await CrawlerSource.findOne({
            crawlerName: this.name,
            sourceRef:   ref,
            status:      'SUCCESS',
        }).lean();

        return !!doc;
    }

    async _markStart(ref, url) {
        await CrawlerSource.findOneAndUpdate(
            { crawlerName: this.name, sourceRef: ref },
            { $set: { status: 'IN_PROGRESS', sourceUrl: url, fetchedAt: new Date() } },
            { upsert: true }
        )
    }

    async _markCompleted(ref, { recordsRaw = 0, recordsSamples = 0 } = {}) {
        await CrawlerSource.findOneAndUpdate(
            { crawlerName: this.name, sourceRef: ref },
            { $set: { status: 'SUCCESS', recordsRaw, recordsSamples, fetchedAt: new Date() } }
        );
    }

    async _markFailed(ref, error) {
        await CrawlerSource.findOneAndUpdate(
            { crawlerName: this.name, sourceRef: ref },
            { $set: { status: 'FAILED', errorMessage: error.message, fetchedAt: new Date() } }
        );
    }

    async _saveRaw(ref, rawType, payload) {
        await RawDocument.create({
            crawlerName: this.name,
            sourceRef: ref,
            rawType,
            payload
        });
    }

    async _saveSamples(samples) {
        if (!samples.length) return 0;
        const ops = samples.map(s => ({
            updateOne: {
                filter: { source: s.source, sourceRef: s.sourceRef },
                update: { $setOnInsert: s },
                upsert: true,
            },
        }));
        const result = await TrainingSample.bulkWrite(ops, { ordered: false });
        return result.upsertedCount;
    }

    async run() {
        logger.info(`[${this.name}] Starting`);

        let workItems;
        try {
            workItems = await this.getWorkItems();
        } catch (err) {
            logger.error(`[${this.name}] getWorkItems failed: ${err.message}`);
            return;
        }

        logger.info(`[${this.name}] ${workItems.length} work items`);

        const limit = pLimit(this.concurrency);
        let processed = 0, skipped = 0, failed = 0, samples = 0;

        const tasks = workItems.map(item => limit(async () => {
            const ref = item.ref;

            if (this.skipIfCrawled && await this._alreadyCrawled(ref)) {
                skipped++;
                return;
            }

            await this._markStart(ref, item.url);

            try {
                await this.sleep(this.delayMs);
                const result = await this.processItem(item);

                if (result.raw) {
                    await this._saveRaw(ref, result.rawType || 'GENERIC', result.raw);
                }

                const upserted = await this._saveSamples(result.samples || []);
                samples += upserted;

                await this._markCompleted(ref, {
                    recordsRaw:     result.raw ? 1 : 0,
                    recordsSamples: upserted,
                });

                processed++;

                if ((processed + skipped + failed) % 20 === 0) {
                    logger.info(`[${this.name}] processed=${processed} skipped=${skipped} failed=${failed} samples=${samples}`);
                }

            } catch (exception) {
                failed++;
                logger.error(`[${this.name}] Failed on ${ref}: ${exception.message}`);
                await this._markFailed(ref, exception);
            }
        }));

        await Promise.all(tasks);

        logger.info(`[${this.name}] Done — processed=${processed} skipped=${skipped} failed=${failed} new_samples=${samples}`);

        return { processed, skipped, failed, samples };
    };
}


module.exports = BaseCrawler;
