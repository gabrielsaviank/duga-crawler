const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const BaseCrawler = require('./BaseCrawler');
const logger = require('../logger');

const DATASETS = [
    {
        year: '2025',
        url: 'https://avaandmed.ariregister.rik.ee/sites/default/files/4.2025_aruannete_elemendid_kuni_31052026_0.zip',
    },
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

class EERegisterCrawler extends BaseCrawler {
    constructor(options = {}) {
        super({
            delayMs: 2000,
            concurrency: 1,
            ...options,
        });

        this.rawDirectory =
            options.rawDirectory ||
            process.env.CRAWLER_RAW_DIRECTORY ||
            '/data/raw/estonian-register';
    }

    get name() {
        return 'ESTONIAN_REGISTER';
    }

    async getWorkItems() {
        return DATASETS.map(dataset => ({
            ref: `EE_ANNUAL_${dataset.year}`,
            url: dataset.url,
            year: dataset.year,
        }));
    }

    async processItem(item) {
        logger.info(
            `[ESTONIAN_REGISTER] Downloading ${item.year} dataset`
        );

        await fsPromises.mkdir(this.rawDirectory, {
            recursive: true,
        });

        const filename = `annual-report-elements-${item.year}.zip`;
        const filePath = path.join(this.rawDirectory, filename);

        const response = await this.fetch(item.url, {
            responseType: 'stream',
            timeout: 10 * 60 * 1000,
        });

        const hash = crypto.createHash('sha256');
        let sizeBytes = 0;

        response.data.on('data', chunk => {
            sizeBytes += chunk.length;
            hash.update(chunk);
        });

        await pipeline(
            response.data,
            fs.createWriteStream(filePath)
        );

        const sha256 = hash.digest('hex');

        logger.info(
            `[ESTONIAN_REGISTER] Stored ${item.year}: ` +
            `${sizeBytes} bytes at ${filePath}`
        );

        return {
            rawType: 'EE_ANNUAL_REPORT_ZIP',
            raw: {
                year: item.year,
                storageType: 'FILE',
                filePath,
                filename,
                contentType: 'application/zip',
                compression: 'zip',
                sizeBytes,
                sha256,
                sourceUrl: item.url,
                fetchedAt: new Date(),
            },
            samples: [],
        };
    }
}

module.exports = EERegisterCrawler;