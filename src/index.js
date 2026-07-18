require('dotenv').config();

const cron = require('node-cron');
const logger = require('./logger');
const db = require('./db/connection');

const SecEdgarCrawler = require('./crawlers/SecEdgarCrawler');
const EERegisterCrawler = require('./crawlers/EERegisterCrawler');

const forceRecrawl = process.env.FORCE_RECRAWL === 'true';

const ALL_CRAWLERS = [
    new SecEdgarCrawler({
        sampleSize: 500,
        skipIfCrawled: !forceRecrawl,
    }),

    new EERegisterCrawler({
        skipIfCrawled: !forceRecrawl,
    }),
];

let crawlRunning = false;

async function runOne(name) {
    const crawler = ALL_CRAWLERS.find(crawler =>
        crawler.name
            .toLocaleLowerCase()
            .includes(name.toLocaleLowerCase())
    );

    if (!crawler) {
        logger.error(`Unknown crawler: ${name}`);
        logger.error(
            `Available: ${ALL_CRAWLERS.map(crawler => crawler.name).join(', ')}`
        );

        throw new Error(`Unknown crawler: ${name}`);
    }

    return crawler.run();
}

async function runAll() {
    if (crawlRunning) {
        logger.warn('Crawler run already active. Skipping overlapping run.');
        return;
    }

    crawlRunning = true;

    try {
        logger.info('Starting all crawlers');

        await ALL_CRAWLERS[0].run();
        await ALL_CRAWLERS[1].run();

        logger.info('All crawlers completed');
    } catch (exception) {
        logger.error(
            `Crawler execution failed: ${exception.stack || exception.message}`
        );
    } finally {
        crawlRunning = false;
    }
}

function scheduleAll() {
    cron.schedule(
        '0 2 * * *',
        async () => {
            logger.info('Cron: starting SEC_EDGAR');

            try {
                await ALL_CRAWLERS[0].run();
            } catch (exception) {
                logger.error(
                    `SEC_EDGAR cron failed: ${exception.stack || exception.message}`
                );
            }
        },
        {
            timezone: 'America/Sao_Paulo',
        }
    );

    cron.schedule(
        '0 3 * * 1',
        async () => {
            logger.info('Cron: starting ESTONIAN_REGISTER');

            try {
                await ALL_CRAWLERS[1].run();
            } catch (exception) {
                logger.error(
                    `ESTONIAN_REGISTER cron failed: ${exception.stack || exception.message}`
                );
            }
        },
        {
            timezone: 'America/Sao_Paulo',
        }
    );

    logger.info('Scheduler running. Waiting for next trigger...');
}

async function shutdown(signal) {
    logger.info(`${signal} received. Shutting down...`);

    await db.disconnect();

    process.exit(0);
}

async function main() {
    await db.connect();

    const onlyArg = process.argv.find(argument =>
        argument.startsWith('--only=')
    );

    if (onlyArg) {
        const name = onlyArg.replace('--only=', '');

        logger.info(`One-shot mode: ${name}`);

        await runOne(name);
        await db.disconnect();

        process.exit(0);
    }

    /*
     * Tonight:
     * run immediately so we do not wait until the scheduled time.
     */
    await runAll();

    /*
     * Afterwards, leave the normal schedules active.
     */
    scheduleAll();

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(exception => {
    logger.error(`Fatal: ${exception.stack || exception.message}`);
    process.exit(1);
});