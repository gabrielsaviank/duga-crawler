const crypto = require('crypto');
const BaseCrawler = require('./BaseCrawler');
const logger = require('../logger');
const { TrainingSample } = require('../db/models');

const PAGE_SIZE = 5000;

/*
 * City of Austin eCheckbook (verified against
 * https://data.austintexas.gov/api/views/8c6z-qnmj on 2026-08-16):
 *   lgl_nm          - vendor legal name
 *   chk_eft_iss_dt  - check/EFT issue date
 *   amount          - payment amount
 *   actg_ln_dscr    - expense description
 *   obj_cd/obj_nm   - object code/name      (most specific)
 *   dept_cd/dept_nm - department code/name
 *   fund_cd/fund_nm - fund code/name        (least specific)
 *
 * Adding Dallas/Houston etc. is config-only: append another entry with
 * its own domain/datasetId/fieldMap.
 *
 * Texas State DIR Cooperative Contract Sales FY2010-2025 (verified against
 * https://data.texas.gov/api/views/w64c-ndf7 on 2026-08-17):
 *   vendor_name       - vendor legal name
 *   order_date        - order date (missing on some rows -> date omitted)
 *   purchase_amount   - total purchase amount (quantity x unit price)
 *   contract_subtype  - expense description (e.g. 'IT Staffing Services')
 *   contract_number/contract_type - most specific classification available
 *   (no object/dept/fund codes exist at state level; customer_name is the
 *    buying agency but there is no agency code column to pair it with)
 */
const DEFAULT_DATASETS = [
    {
        domain: 'data.austintexas.gov',
        datasetId: '8c6z-qnmj',
        source: 'US_TX_AUSTIN',
        country: 'US',
        currency: 'USD',
        fieldMap: {
            vendor: 'lgl_nm',
            date: 'chk_eft_iss_dt',
            amount: 'amount',
            description: 'actg_ln_dscr',
            objectCode: 'obj_cd',
            objectLabel: 'obj_nm',
            departmentCode: 'dept_cd',
            departmentLabel: 'dept_nm',
            fundCode: 'fund_cd',
            fundLabel: 'fund_nm',
        },
    },
    {
        domain: 'data.texas.gov',
        datasetId: 'w64c-ndf7',
        source: 'US_TX_STATE',
        country: 'US',
        currency: 'USD',
        fieldMap: {
            vendor: 'vendor_name',
            date: 'order_date',
            amount: 'purchase_amount',
            description: 'contract_subtype',
            objectCode: 'contract_number',
            objectLabel: 'contract_type',
        },
    },
];

class SocrataCheckbookCrawler extends BaseCrawler {
    constructor(options = {}) {
        super({
            delayMs: 1000,
            concurrency: 1,
            ...options,
        });

        this.datasets = options.datasets ?? DEFAULT_DATASETS;
        this.maxSamples = options.maxSamples ?? 50000;
        this.samplesThisRun = 0;
    }

    get name() {
        return 'SOCRATA_CHECKBOOK';
    }

    async getWorkItems() {
        this.samplesThisRun = 0;

        const items = [];

        for (const dataset of this.datasets) {
            const columns = await this._fetchColumns(dataset);

            logger.info(
                `[SOCRATA_CHECKBOOK] ${dataset.domain}/${dataset.datasetId} ` +
                `(${dataset.source}) fields: ${columns.join(', ')}`
            );

            this._warnUnmappedFields(dataset, columns);

            items.push({
                ref: `SOCRATA_${dataset.domain}_${dataset.datasetId}`,
                url: `https://${dataset.domain}/resource/${dataset.datasetId}.json`,
                dataset,
            });
        }

        return items;
    }

    async _fetchColumns(dataset) {
        try {
            const response = await this.fetch(
                `https://${dataset.domain}/api/views/${dataset.datasetId}`
            );

            return (response.data?.columns || [])
                .map(column => column.fieldName)
                .filter(Boolean);
        } catch (exception) {
            logger.warn(
                `[SOCRATA_CHECKBOOK] Column metadata fetch failed for ` +
                `${dataset.domain}/${dataset.datasetId}: ${exception.message}`
            );

            return [];
        }
    }

    _warnUnmappedFields(dataset, columns) {
        if (!columns.length) return;

        const missing = Object.values(dataset.fieldMap)
            .filter(field => field && !columns.includes(field));

        if (missing.length) {
            logger.warn(
                `[SOCRATA_CHECKBOOK] ${dataset.source}: fieldMap fields not ` +
                `present in dataset: ${missing.join(', ')}`
            );
        }
    }

    async processItem(item) {
        const { dataset } = item;

        let offset = 0;
        let fetchedRows = 0;
        let insertedCount = 0;
        let duplicateCount = 0;
        let skipped = 0;

        while (this.samplesThisRun < this.maxSamples) {
            const response = await this.fetch(item.url, {
                params: {
                    $limit: PAGE_SIZE,
                    $offset: offset,
                    $order: ':id',
                },
                headers: { 'User-Agent': 'duga-crawler/1.0 (+bookkeeping research)' },
            });

            const rows = Array.isArray(response.data) ? response.data : [];

            if (!rows.length) break;

            fetchedRows += rows.length;

            const { samples, skipped: pageSkipped } =
                this._mapRows(dataset, rows, offset);

            skipped += pageSkipped;

            const budget = this.maxSamples - this.samplesThisRun;
            const cappedSamples = samples.slice(0, budget);

            const pageResult = await this._insertSamples(cappedSamples);

            insertedCount += pageResult.insertedCount;
            duplicateCount += pageResult.duplicateCount;
            this.samplesThisRun += pageResult.insertedCount;

            offset += rows.length;

            logger.info(
                `[SOCRATA_CHECKBOOK] ${dataset.source}: page rows=${rows.length} ` +
                `offset=${offset} inserted=${insertedCount} ` +
                `duplicates=${duplicateCount} skipped=${skipped} ` +
                `runTotal=${this.samplesThisRun}`
            );

            if (rows.length < PAGE_SIZE) break;

            await this.sleep(this.delayMs);
        }

        logger.info(
            `[SOCRATA_CHECKBOOK] ${dataset.source}: rows=${fetchedRows} ` +
            `inserted=${insertedCount} duplicates=${duplicateCount} ` +
            `skipped=${skipped}`
        );

        return {
            rawType: 'SOCRATA_CHECKBOOK_METADATA',

            raw: {
                sourceUrl: item.url,
                domain: dataset.domain,
                datasetId: dataset.datasetId,
                source: dataset.source,
                rowsFetched: fetchedRows,
                inserted: insertedCount,
                duplicates: duplicateCount,
                skipped,
                capped: this.samplesThisRun >= this.maxSamples,
                fetchedAt: new Date(),
            },

            samples: [],
            insertedCount,
        };
    }

    _mapRows(dataset, rows, offset) {
        const { fieldMap } = dataset;
        const samples = [];
        let skipped = 0;

        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
            const row = rows[rowIndex];

            const vendor = String(row[fieldMap.vendor] ?? '').trim();
            const amount = Number(row[fieldMap.amount]);

            if (!vendor || !Number.isFinite(amount)) {
                skipped++;
                continue;
            }

            const { accountCode, accountLabel } = this._pickAccount(row, fieldMap);

            const expenseDescription = String(
                row[fieldMap.description] ?? ''
            ).trim();

            const date = row[fieldMap.date]
                ? new Date(row[fieldMap.date])
                : null;

            samples.push({
                description: expenseDescription
                    ? `${expenseDescription} - ${vendor}`
                    : vendor,
                accountCode,
                accountLabel: accountLabel || undefined,
                counterpartyName: vendor,
                amount,
                date: date && !Number.isNaN(date.getTime()) ? date : undefined,
                country: dataset.country,
                currency: dataset.currency,
                source: dataset.source,
                sourceRef: crypto
                    .createHash('sha256')
                    .update(`${dataset.datasetId}:${offset + rowIndex}`)
                    .digest('hex'),
            });
        }

        return { samples, skipped };
    }

    /* Most specific code wins: object > department > fund. */
    _pickAccount(row, fieldMap) {
        const candidates = [
            [fieldMap.objectCode, fieldMap.objectLabel],
            [fieldMap.departmentCode, fieldMap.departmentLabel],
            [fieldMap.fundCode, fieldMap.fundLabel],
        ];

        for (const [codeField, labelField] of candidates) {
            const code = String(row[codeField] ?? '').trim();

            if (code) {
                return {
                    accountCode: code,
                    accountLabel: String(row[labelField] ?? '').trim(),
                };
            }
        }

        return { accountCode: 'uncategorised', accountLabel: '' };
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

module.exports = SocrataCheckbookCrawler;
