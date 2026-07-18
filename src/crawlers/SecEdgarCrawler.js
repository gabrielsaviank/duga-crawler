const BaseCrawler = require("./BaseCrawler");
const logger = require("../logger");

class SecEdgar extends BaseCrawler {
    constructor(options = {}) {
        super({
            delayMs: 250,
            concurrency: 1,
            ...options,
        });

        this.sampleSize = options.sampleSize ?? 500;
    }

    get name() {
        return 'SEC_EDGAR';
    }

    async getWorkItems() {
        logger.info('[SEC_EDGAR] Fetching company list');

        const response = await this.fetch(
            'https://www.sec.gov/files/company_tickers.json'
        );

        const companies = Object.values(response.data);

        const sampledCompanies = this._sampleEvenly(
            companies,
            this.sampleSize
        );

        logger.info(
            `[SEC_EDGAR] Sampled ${sampledCompanies.length} from ${companies.length} companies`
        );

        return sampledCompanies.map(company => {
            const paddedCik = String(company.cik_str).padStart(10, '0');

            return {
                ref: `CIK_${paddedCik}`,
                url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${paddedCik}.json`,
                cik: company.cik_str,
                ticker: company.ticker,
                name: company.title,
            };
        });
    }

    async processItem(item) {
        let response;

        try {
            response = await this.fetch(item.url);
        } catch (exception) {
            logger.error(
                `[SEC_EDGAR] Fetch failed for ${item.ref}: ${exception.message}`
            );

            throw exception;
        }

        const payload = response.data;

        const rawSizeBytes = Buffer.byteLength(
            JSON.stringify(payload),
            'utf8'
        );

        logger.debug(
            `[SEC_EDGAR] ${item.ref} raw=${rawSizeBytes} bytes`
        );

        return {
            rawType: 'XBRL_COMPANY_FACTS',

            raw: {
                ...payload,

                _dugaMetadata: {
                    fetchedAt: new Date(),
                    sourceUrl: item.url,
                    rawSizeBytes,
                    cik: item.cik,
                    ticker: item.ticker,
                    companyName: item.name,
                },
            },

            samples: [],
        };
    }

    _sampleEvenly(companies, sampleSize) {
        if (companies.length <= sampleSize) {
            return companies;
        }

        const step = companies.length / sampleSize;
        const sampled = [];

        for (let index = 0; index < sampleSize; index++) {
            sampled.push(
                companies[Math.floor(index * step)]
            );
        }

        return sampled;
    }
}

module.exports = SecEdgar;