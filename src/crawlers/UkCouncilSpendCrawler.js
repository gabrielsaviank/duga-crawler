const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const BaseCrawler = require('./BaseCrawler');
const logger = require('../logger');
const { TrainingSample } = require('../db/models');

const CKAN_BASE = 'https://ckan.publishing.service.gov.uk';
const MIN_AMOUNT = 500;

const HEADER_ALIASES = {
    supplier: ['suppliername', 'supplier', 'bodyname', 'vendorname', 'payeename'],
    date: ['paymentdate', 'date', 'paiddate', 'transactiondate'],
    amount: ['amount', 'netamount', 'amountpaid', 'total', 'value', 'paymentamount'],
    category: ['expensetype', 'expensescategory', 'category', 'service', 'department', 'costcentre', 'servicedivision'],
};

class UkCouncilSpendCrawler extends BaseCrawler {
    constructor(options = {}) {
        super({
            delayMs: 1000,
            concurrency: 1,
            ...options,
        });

        this.maxSamples = options.maxSamples ?? 10000;
        this.samplesThisRun = 0;
    }

    get name() {
        return 'UK_COUNCIL_SPEND';
    }

    async getWorkItems() {
        this.samplesThisRun = 0;

        logger.info('[UK_COUNCIL_SPEND] Searching CKAN for spending datasets');

        const searchResponse = await this.fetch(
            `${CKAN_BASE}/api/3/action/package_search`,
            { params: { q: 'spending over 500', rows: 20 } }
        );

        const packages = searchResponse.data?.result?.results || [];

        logger.info(`[UK_COUNCIL_SPEND] ${packages.length} packages found`);

        const items = [];

        for (const pkg of packages) {
            try {
                const showResponse = await this.fetch(
                    `${CKAN_BASE}/api/3/action/package_show`,
                    { params: { id: pkg.name } }
                );

                const resources = showResponse.data?.result?.resources || [];

                for (const resource of resources) {
                    const format = (resource.format || '').toLowerCase();
                    const url = resource.url || '';

                    if (format !== 'csv' && !url.toLowerCase().endsWith('.csv')) {
                        continue;
                    }

                    items.push({
                        ref: `UK_SPEND_${resource.id}`,
                        url,
                        packageName: pkg.name,
                    });
                }
            } catch (exception) {
                logger.warn(
                    `[UK_COUNCIL_SPEND] package_show failed for ${pkg.name}: ${exception.message}`
                );
            }

            await this.sleep(this.delayMs);
        }

        return items;
    }

    async processItem(item) {
        if (this.samplesThisRun >= this.maxSamples) {
            logger.info(
                `[UK_COUNCIL_SPEND] maxSamples (${this.maxSamples}) reached — ` +
                `stopping before ${item.ref}`
            );

            return {
                rawType: 'UK_COUNCIL_SPEND_METADATA',
                raw: {
                    sourceUrl: item.url,
                    capped: true,
                    fetchedAt: new Date(),
                },
                samples: [],
                insertedCount: 0,
            };
        }

        const response = await this.fetch(item.url, {
            responseType: 'text',
            timeout: 120 * 1000,
        });

        const content = String(response.data);
        const sizeBytes = Buffer.byteLength(content, 'utf8');
        const sha256 = crypto
            .createHash('sha256')
            .update(content)
            .digest('hex');

        const records = parse(content, {
            columns: true,
            relax_column_count: true,
            skip_lines_with_error: true,
            bom: true,
            trim: true,
        });

        const { samples, skipped } = this._mapRecords(item.url, records);

        const budget = this.maxSamples - this.samplesThisRun;
        const cappedSamples = samples.slice(0, budget);

        const { insertedCount, duplicateCount } =
            await this._insertSamples(cappedSamples);

        this.samplesThisRun += insertedCount;

        logger.info(
            `[UK_COUNCIL_SPEND] ${item.packageName}: rows=${records.length} ` +
            `inserted=${insertedCount} duplicates=${duplicateCount} ` +
            `skipped=${skipped} runTotal=${this.samplesThisRun}`
        );

        return {
            rawType: 'UK_COUNCIL_SPEND_METADATA',

            raw: {
                sourceUrl: item.url,
                sha256,
                sizeBytes,
                rowCount: records.length,
                inserted: insertedCount,
                skipped,
                fetchedAt: new Date(),
            },

            samples: [],
            insertedCount,
        };
    }

    _mapRecords(resourceUrl, records) {
        const samples = [];
        let skipped = 0;

        for (let rowIndex = 0; rowIndex < records.length; rowIndex++) {
            const row = this._normalizeRow(records[rowIndex]);

            const supplier = (row.supplier || '').trim();
            if (!supplier) {
                skipped++;
                continue;
            }

            const amount = this._parseAmount(row.amount);
            if (amount === null || Math.abs(amount) < MIN_AMOUNT) {
                skipped++;
                continue;
            }

            const category = (row.category || '').trim();

            samples.push({
                description: category
                    ? `${category} - ${supplier}`
                    : supplier,
                accountCode: category
                    ? this._slugify(category)
                    : 'uncategorised',
                accountLabel: category || undefined,
                counterpartyName: supplier,
                country: 'UK',
                currency: 'GBP',
                source: 'UK_COUNCIL_SPEND',
                sourceRef: crypto
                    .createHash('sha256')
                    .update(`${resourceUrl}:${rowIndex}`)
                    .digest('hex'),
            });
        }

        return { samples, skipped };
    }

    _normalizeRow(record) {
        const normalized = {};

        for (const [key, value] of Object.entries(record)) {
            const normalizedKey = key
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '');

            for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
                if (aliases.includes(normalizedKey) && !(field in normalized)) {
                    normalized[field] = value;
                }
            }
        }

        return normalized;
    }

    _parseAmount(rawAmount) {
        if (rawAmount === undefined || rawAmount === null) return null;

        const cleaned = String(rawAmount).replace(/[£,\s]/g, '');
        if (!cleaned) return null;

        const amount = parseFloat(cleaned);

        return Number.isFinite(amount) ? amount : null;
    }

    _slugify(text) {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    async _insertSamples(samples) {
        if (!samples.length) {
            return { insertedCount: 0, duplicateCount: 0 };
        }

        try {
            const result = await TrainingSample.insertMany(samples, {
                ordered: false,
            });

            return { insertedCount: result.length, duplicateCount: 0 };
        } catch (exception) {
            if (exception.code === 11000) {
                const insertedCount = exception.insertedDocs
                    ? exception.insertedDocs.length
                    : exception.result?.result?.nInserted ?? 0;

                return {
                    insertedCount,
                    duplicateCount: samples.length - insertedCount,
                };
            }

            throw exception;
        }
    }
}

module.exports = UkCouncilSpendCrawler;
