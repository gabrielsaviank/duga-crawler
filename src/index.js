require('dotenv').config();
const cron   = require('node-cron');
const logger = require('./logger');
const db     = require('./db/connection');

const SecEdgarCrawler = require("./crawlers/SecEdgarCrawler");

const ALL_CRAWLERS = [
    new SecEdgarCrawler({
        sampleSize: 500
    }),
    // OTHER CRAWLERS EE,
];

async function runOne(name) {
    const crawler = ALL_CRAWLERS.find(crawler =>
    crawler.name.toLocaleLowerCase().includes(name.toLowerCase()));

    if (!crawler) {
        logger.error(`Unknown crawler: ${name}`);
        logger.error(`Available: ${ALL_CRAWLERS.map(c => c.name).join(', ')}`);

        process.exit(1);
    }

    await crawler.run();
}

function scheduleAll() {
    cron.schedule('0 2 * * *', () => {
        logger.info('Cron: starting SEC_EDGAR');
        ALL_CRAWLERS[0].run();
    });
    logger.info('Scheduler running. Waiting for next trigger...');
}

async function main() {
    await db.connect();

    const onlyArg = process.argv.find(a => a.startsWith('--only='));

    if(onlyArg) {
        const name = onlyArg.replace('--only=', '');
        logger.info(`One-shot mode: ${name}`);
        await runOne(name);
        await db.disconnect();

        process.exit(0);
    }

    scheduleAll();

    process.on("SIGINT", async () => {
        logger.info('Shutting down...');
        await db.disconnect();
        process.exit(0);
    });
}

main().catch((exception) => {
    logger.error(`Fatal: ${exception.message}`);
    process.exit(1);
})
