const BaseCrawler = require('./BaseCrawler');
const logger = require('../logger');

const EE_GAAP_MAP = {
    // Revenue
    'revenue':                          { code: '3000', label: 'Revenue' },
    'totalRevenue':                     { code: '3000', label: 'Total revenue' },
    // Employee costs
    'employeeExpense':                  { code: '5300', label: 'Employee expense' },
    // Depreciation
    'depreciationAndImpairmentLoss':    { code: '5400', label: 'Depreciation and impairment loss' },
    // Operating profit
    'operatingProfitLoss':              { code: '5900', label: 'Operating profit/loss' },
    // Net profit
    'annualPeriodProfitLoss':           { code: '6200', label: 'Annual period profit/loss' },
    // Tax
    'profitLossBeforeTax':              { code: '6100', label: 'Profit/loss before tax' },
    // Assets
    'assets':                           { code: '1000', label: 'Total assets' },
    'totalCurrentAssets':               { code: '1100', label: 'Total current assets' },
    'totalNonCurrentAssets':            { code: '1500', label: 'Total non-current assets' },
    'cashAndCashEquivalents':           { code: '1010', label: 'Cash and cash equivalents' },
    // Liabilities
    'currentLiabilities':               { code: '2000', label: 'Current liabilities' },
    'nonCurrentLiabilities':            { code: '2100', label: 'Non-current liabilities' },
    // Equity
    'equity':                           { code: '3500', label: 'Equity' },
    'retainedEarningsLoss':             { code: '3510', label: 'Retained earnings/loss' },
};

class EERegisterCrawler extends BaseCrawler {
    constructor(options = {}) {
        super({
            delayMs: 1000,
            concurrency: 1,
            ...options
        });
    }

    get name() {
        return 'ESTONIAN_REGISTER';
    }

    async getWorkItems() {
        logger.info('[ESTONIAN_REGISTER] Fetching annual report dataset');

        const resp = await this.fetch(
            'https://avaandmed.ariregister.rik.ee/api/ariregister/download?andmestik=majandusaasta_aruanded',
            { headers: { 'Accept': 'application/json' } }
        );

        const records = Array.isArray(resp.data) ? resp.data : resp.data?.data || [];
        logger.info(`[ESTONIAN_REGISTER] ${records.length} records found`);

        const byCompany = {};
        for (const record of records) {
            const key = record.ariregistri_kood || record.registryCode || record.registry_code;
            if (!key) continue;
            if (!byCompany[key]) byCompany[key] = { records: [], name: record.nimi || record.name };
            byCompany[key].records.push(record);
        }

        return Object.entries(byCompany).map(([code, data]) => ({
            ref:     `EE_${code}`,
            url:     `https://avaandmed.ariregister.rik.ee/api/ariregister/download?andmestik=majandusaasta_aruanded`,
            code,
            name:    data.name,
            records: data.records,
        }));
    }

    async processItems(item) {
        const samples = [];

        for (const record of item.records) {
            for (const [field, mapped] of Object.entries(EE_GAAP_MAP)) {
                const value = record[field] ?? record[this._toSnakeCase(field)];
                if (value === null || value === undefined) continue;

                samples.push({
                    description:      mapped.label,
                    accountCode:      mapped.code,
                    accountLabel:     mapped.label,
                    counterpartyName: item.name,
                    country:          'EE',
                    currency:         'EUR',
                    source:           this.name,
                    sourceRef:        `${item.ref}::${field}::${record.aruandeaasta || record.year || ''}`,
                    confidence:       0.8,
                });
            }
        }

        logger.debug(`[ESTONIAN_REGISTER] ${item.name} → ${samples.length} samples`);

        return {
            rawType: 'EE_ANNUAL_REPORT',
            raw: {
                code:    item.code,
                name:    item.name,
                records: item.records,
            },
            samples,
        };
    }

    _toSnakeCase(str) {
        return str.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
    }
}

module.exports = EERegisterCrawler;