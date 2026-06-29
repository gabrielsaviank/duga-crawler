const BaseCrawler = require('./BaseCrawler');
const logger = require('../logger');

const DATASETS = [
    {
        year: '2024',
        url: 'https://avaandmed.ariregister.rik.ee/sites/default/files/4.2024_aruannete_elemendid_kuni_31052026_0.zip',
    },
    {
        year: '2023',
        url: 'https://avaandmed.ariregister.rik.ee/sites/default/files/4.2023_aruannete_elemendid_kuni_31052026_0.zip',
    },
    {
        year: '2022',
        url: 'https://avaandmed.ariregister.rik.ee/sites/default/files/4.2022_aruannete_elemendid_kuni_31052026_0.zip',
    },
];

const FIELD_MAP = {
    'Müügitulu':                                    { code: '3000', label: 'Revenue' },
    'Raha':                                         { code: '1010', label: 'Cash and cash equivalents' },
    'Käibevarad':                                   { code: '1100', label: 'Total current assets' },
    'Põhivarad':                                    { code: '1500', label: 'Total non-current assets' },
    'Varad':                                        { code: '1000', label: 'Total assets' },
    'Lühiajalised kohustised':                      { code: '2000', label: 'Current liabilities' },
    'Pikaajalised kohustised':                      { code: '2100', label: 'Non-current liabilities' },
    'Omakapital':                                   { code: '3500', label: 'Equity' },
    'Tööjõukulud':                                  { code: '5300', label: 'Employee expense' },
    'Põhivarade kulum ja väärtuse langus':          { code: '5400', label: 'Depreciation and impairment loss' },
    'Ärikasum (kahjum)':                            { code: '5900', label: 'Operating profit/loss' },
    'Aruandeaasta kasum (kahjum)':                  { code: '6200', label: 'Annual period profit/loss' },
    'Kasum (kahjum) enne tulumaksustamist':         { code: '6100', label: 'Profit/loss before tax' },
    'Eelmiste perioodide jaotamata kasum (kahjum)': { code: '3510', label: 'Retained earnings/loss' },
    'Netovara':                                     { code: '3500', label: 'Net assets' },
    'Kohustised ja netovara':                       { code: '2900', label: 'Liabilities and net assets' },
};

class EERegisterCrawler extends BaseCrawler {
    constructor(options = {}) {
        super({
            delayMs:     2000,
            concurrency: 1,
            ...options,
        });
    }

    get name() { return 'ESTONIAN_REGISTER'; }

    async getWorkItems() {
        return DATASETS.map(ds => ({
            ref:  `EE_ANNUAL_${ds.year}`,
            url:  ds.url,
            year: ds.year,
        }));
    }

    async processItem(item) {
        logger.info(`[ESTONIAN_REGISTER] Downloading ${item.year} dataset`);

        const resp = await this.fetch(item.url, {
            responseType: 'arraybuffer',
        });

        const AdmZip = require('adm-zip');
        const zip = new AdmZip(Buffer.from(resp.data));
        const entries = zip.getEntries();

        const indicatorsEntry = entries.find(e =>
            e.entryName.includes('elemendid') || e.entryName.includes('4.')
        );

        if (!indicatorsEntry) {
            logger.warn(`[ESTONIAN_REGISTER] No indicators file found in ${item.year} ZIP`);
            logger.warn(`[ESTONIAN_REGISTER] Available files: ${entries.map(e => e.entryName).join(', ')}`);
            return { rawType: 'EE_ANNUAL_REPORT', raw: null, samples: [] };
        }

        const csv = indicatorsEntry.getData().toString('utf8');
        const samples = this._parseCsv(csv, item.year);

        logger.info(`[ESTONIAN_REGISTER] ${item.year} → ${samples.length} samples`);

        return {
            rawType: 'EE_ANNUAL_REPORT',
            raw:     { year: item.year, rows: csv.split('\n').length },
            samples,
        };
    }

    _parseCsv(csv, year) {
        const lines  = csv.split('\n').filter(l => l.trim());
        const samples = [];

        for (const line of lines.slice(1, 5001)) {
            const cols         = line.split(';').map(c => c.replace(/"/g, '').trim());
            const reportId     = cols[0];
            const elementName  = cols[2];
            const elementLabel = cols[3];
            const value        = parseFloat(cols[4]);

            if (isNaN(value) || value === 0) continue;

            const mapped = FIELD_MAP[elementName];
            if (!mapped) continue;

            samples.push({
                description:      elementName,
                accountCode:      mapped.code,
                accountLabel:     mapped.label,
                counterpartyName: null,
                country:          'EE',
                currency:         'EUR',
                source:           this.name,
                sourceRef:        `EE_${reportId}::${elementLabel}::${year}`,
                confidence:       0.85,
            });
        }

        return samples;
    }
}

module.exports = EERegisterCrawler;