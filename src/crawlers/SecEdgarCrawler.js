const BaseCrawler = require("./BaseCrawler");
const logger = require("../logger");

const GAAP_MAP = {
    // Revenue
    'Revenues':                                                { code: '3000', label: 'Revenue' },
    'RevenueFromContractWithCustomerExcludingAssessedTax':     { code: '3000', label: 'Revenue from contracts' },
    'SalesRevenueNet':                                         { code: '3000', label: 'Net sales revenue' },
    'ServiceRevenue':                                          { code: '3010', label: 'Service revenue' },
    'SubscriptionRevenue':                                     { code: '3010', label: 'Subscription revenue' },
    'AdvertisingRevenue':                                      { code: '3020', label: 'Advertising revenue' },
    // COGS
    'CostOfRevenue':                                           { code: '4000', label: 'Cost of revenue' },
    'CostOfGoodsAndServicesSold':                              { code: '4000', label: 'Cost of goods and services' },
    'CostOfGoodsSold':                                         { code: '4000', label: 'Cost of goods sold' },
    'CostOfServices':                                          { code: '4010', label: 'Cost of services' },
    // R&D
    'ResearchAndDevelopmentExpense':                           { code: '5000', label: 'Research and development' },
    // Sales & Marketing
    'SellingAndMarketingExpense':                              { code: '5200', label: 'Sales and marketing' },
    'MarketingExpense':                                        { code: '5200', label: 'Marketing expense' },
    'AdvertisingExpense':                                      { code: '5210', label: 'Advertising expense' },
    // G&A
    'GeneralAndAdministrativeExpense':                         { code: '5100', label: 'General and administrative' },
    'SellingGeneralAndAdministrativeExpense':                  { code: '5100', label: 'Selling, general and administrative' },
    // Payroll
    'LaborAndRelatedExpense':                                  { code: '5300', label: 'Labor and related costs' },
    'SalariesAndWages':                                        { code: '5310', label: 'Salaries and wages' },
    'EmployeeBenefitsAndShareBasedCompensation':               { code: '5320', label: 'Employee benefits' },
    // Depreciation
    'DepreciationAndAmortization':                             { code: '5400', label: 'Depreciation and amortization' },
    'Depreciation':                                            { code: '5400', label: 'Depreciation' },
    'AmortizationOfIntangibleAssets':                          { code: '5410', label: 'Amortization of intangibles' },
    // Other operating
    'LeaseAndRentalExpense':                                   { code: '5500', label: 'Lease and rental expense' },
    'RestructuringCharges':                                    { code: '5510', label: 'Restructuring charges' },
    // Finance
    'InterestExpense':                                         { code: '6000', label: 'Interest expense' },
    'InterestAndDebtExpense':                                  { code: '6000', label: 'Interest and debt expense' },
    // Tax
    'IncomeTaxExpenseBenefit':                                 { code: '6100', label: 'Income tax expense' },
};


class SecEdgar extends BaseCrawler {
    constructor(options = []) {
        super({
            delayMs:     200,
            concurrency: 1,
            ...options,
        });

        this.samples = options.samples;
    }

    get name() {
        return 'SEC_EDGAR';
    }

    async getWorkItems() {
        logger.info('[SEC_EDGAR] Firmenliste abrufen');

        const resp = await this.fetch('https://www.sec.gov/files/company_tickers.json');
        const companies = Object.values(resp.data);
        const sampled = this._sampleEvenly(companies, this.sampleSize);
        logger.info(`[SEC_EDGAR] Stichprobe ${sampled.length} ab ${companies.length} firma`);

        return sampled.map(c => {
            const cik = String(c.cik_str).padStart(10, '0');
            return {
                ref:    `CIK_${cik}`,
                url:    `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
                cik:    c.cik_str,
                ticker: c.ticker,
                name:   c.title,
            };
        });
    };

    async processItem(item) {
        const response        = await this.fetch(item.url);
        const facts       = response.data?.facts?.['us-gaap'] || {};
        const entityName  = response.data?.entityName || item.name;
        const samples     = [];

        for (const [concept, conceptData] of Object.entries(facts)) {
            const mapped = GAAP_MAP[concept];
            if (!mapped) continue;

            const label = conceptData.label || mapped.label;

            samples.push({
                description:      label,
                accountCode:      mapped.code,
                accountLabel:     mapped.label,
                counterpartyName: entityName,
                country:          'US',
                currency:         'USD',
                source:           this.name,
                sourceRef:        `${item.ref}::${concept}`,
                confidence:       0.85,
            });
        }

        logger.debug(`[SEC_EDGAR] ${entityName} → ${samples.length} proben`);
    };

    _sampleEvenly(companiesArray, nSize) {
        if (companiesArray.length <= nSize) return companiesArray;
        const step = companiesArray.length / nSize;
        const result = [];

        for (let i = 0; i < nSize; i++) {
            result.push(companiesArray[Math.floor(i * step)]);
        }

        return result;
    };
}

module.exports = SecEdgar;