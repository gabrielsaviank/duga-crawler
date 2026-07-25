const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const BaseCrawler = require('./BaseCrawler');
const logger = require('../logger');
const { TrainingSample } = require('../db/models');

const CKAN_BASE = 'https://ckan.publishing.service.gov.uk';
const MIN_AMOUNT = 500;
const MAX_SAMPLES_PER_FILE = 500;

const HEADER_ALIASES = {
    supplier: ['suppliername', 'supplier', 'bodyname', 'vendorname', 'payeename'],
    date: ['paymentdate', 'date', 'paiddate', 'transactiondate'],
    amount: ['amount', 'netamount', 'amountpaid', 'total', 'value', 'paymentamount'],
    category: [
        // GPC merchant categories (standardised across councils — highest value)
        'merchantcategorygroupdescription',
        'merchantcategorygroup',
        'merchantcategorycodedescription',
        'merchantcategorycode',
        'mechantcategorygroupdescription',      // typo variant seen in the wild
        'mechantcategorycodedescription',       // typo variant
        // council statement columns
        'expenditurecategory',
        'detailedexpensestype',
        'expensetype',
        'expensescategory',
        'category',
        'servicelabel',
        'service',
        'servicearea',
        'directorate',
        'department',
        'costcentre',
        'servicedivision',
        'organisationalunit',
    ],
};

class UkCouncilSpendCrawler extends BaseCrawler {
    constructor(options = {}) {
        super({
            delayMs: 1000,
            concurrency: 1,
            ...options,
        });

        this.maxSamples = options.maxSamples ?? 50000;
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
            { params: { q: 'spending over 500', rows: 100 } }
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
            headers: { 'User-Agent': 'duga-crawler/1.0 (+bookkeeping research)' },
        });

        const content = String(response.data);
        const contentType = String(response.headers['content-type'] || '');

        if (contentType.includes('html') || /^\s*</.test(content)) {
            logger.warn(`[UK_COUNCIL_SPEND] ${item.packageName}: not a CSV (${contentType || 'no content-type'}) — skipping ${item.url}`);

            return {
                rawType: 'UK_COUNCIL_SPEND_METADATA',
                raw: {
                    sourceUrl: item.url,
                    deadLink: true,
                    contentType,
                    fetchedAt: new Date(),
                },
                samples: [],
                insertedCount: 0,
            };
        }

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

        const fileCappedSamples = samples.slice(0, MAX_SAMPLES_PER_FILE);
        const budget = this.maxSamples - this.samplesThisRun;
        const cappedSamples = fileCappedSamples.slice(0, budget);

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
            const row = this._normaliseRow(records[rowIndex]);

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
            const date = this._parseDate(row.date);

            samples.push({
                description: category
                    ? `${category} - ${supplier}`
                    : supplier,
                accountCode: category
                    ? this._slugify(category)
                    : 'uncategorised',
                accountLabel: category || undefined,
                counterpartyName: supplier,
                amount,
                date: date || undefined,
                country: 'UK',
                currency: 'GBP',
                source: 'UK_COUNCIL_SPEND',
                sourceRef: crypto
                    .createHash('sha256')
                    .update(`${resourceUrl}:${rowIndex}`)
                    .digest('hex'),
            });
        }

        if (
            samples.length > 0 &&
            samples.every((sample) => sample.accountCode === 'uncategorised')
        ) {
            const headers = records.length > 0 ? Object.keys(records[0]) : [];

            logger.warn(
                `[UK_COUNCIL_SPEND] ${resourceUrl}: all ${samples.length} samples ` +
                `uncategorised — actual headers: ${headers.join(', ')}`
            );
        }

        return { samples, skipped };
    }

    _normaliseRow(record) {
        const valuesByHeader = {};

        for (const [key, value] of Object.entries(record)) {
            const normalisedKey = key
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '');

            if (!(normalisedKey in valuesByHeader)) {
                valuesByHeader[normalisedKey] = value;
            }
        }

        const normalised = {};

        for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
            for (const alias of aliases) {
                if (alias in valuesByHeader) {
                    normalised[field] = valuesByHeader[alias];
                    break;
                }
            }
        }

        return normalised;
    }

    _parseDate(rawDate) {
        if (rawDate === undefined || rawDate === null) return null;

        const text = String(rawDate).trim();
        if (!text) return null;

        const dmyMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (dmyMatch) {
            const day = Number(dmyMatch[1]);
            const month = Number(dmyMatch[2]);
            const year = Number(dmyMatch[3]);

            if (month < 1 || month > 12 || day < 1 || day > 31) return null;

            const date = new Date(Date.UTC(year, month - 1, day));

            return Number.isNaN(date.getTime()) ? null : date;
        }

        const parsed = new Date(text);

        return Number.isNaN(parsed.getTime()) ? null : parsed;
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
