require('dotenv').config();

const cron = require('node-cron');
const logger = require('./logger');
const db = require('./db/connection');
const { CrawlerSource, TrainingSample } = require('./db/models');

const SecEdgarCrawler = require('./crawlers/SecEdgarCrawler');
const EERegisterCrawler = require('./crawlers/EERegisterCrawler');
const BeancountLedgerCrawler = require('./crawlers/BeancountLedgerCrawler');
const UkCouncilSpendCrawler = require('./crawlers/UkCouncilSpendCrawler');

const forceRecrawl = process.env.FORCE_RECRAWL === 'true';

const ALL_CRAWLERS = [
    new SecEdgarCrawler({
        sampleSize: 500,
        skipIfCrawled: !forceRecrawl,
    }),

    new EERegisterCrawler({
        skipIfCrawled: !forceRecrawl,
    }),

    new BeancountLedgerCrawler({
        skipIfCrawled: !forceRecrawl,
    }),

    new UkCouncilSpendCrawler({
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

async function printStats() {
    const sourceRows = await CrawlerSource.aggregate([
        {
            $group: {
                _id: '$crawlerName',
                files: { $sum: 1 },
                success: {
                    $sum: { $cond: [{ $eq: ['$status', 'SUCCESS'] }, 1, 0] },
                },
                failed: {
                    $sum: { $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0] },
                },
                inProgress: {
                    $sum: { $cond: [{ $eq: ['$status', 'IN_PROGRESS'] }, 1, 0] },
                },
                rawRecords: { $sum: '$recordsRaw' },
                sampleRecords: { $sum: '$recordsSamples' },
            },
        },
        { $sort: { _id: 1 } },
    ]);

    const sampleRows = await TrainingSample.aggregate([
        {
            $group: {
                _id: '$source',
                count: { $sum: 1 },
            },
        },
        { $sort: { _id: 1 } },
    ]);

    // eslint-disable-next-line no-console
    console.log('\n=== Crawler sources ===');
    console.log(
        `${'Crawler'.padEnd(24)} ${'Files'.padStart(8)} ${'Success'.padStart(8)} ${'Failed'.padStart(8)} ${'InProgress'.padStart(11)} ${'RawRecs'.padStart(10)} ${'SampleRecs'.padStart(12)}`
    );
    console.log('-'.repeat(85));

    for (const row of sourceRows) {
        console.log(
            `${row._id.padEnd(24)} ${String(row.files).padStart(8)} ${String(row.success).padStart(8)} ${String(row.failed).padStart(8)} ${String(row.inProgress).padStart(11)} ${String(row.rawRecords).padStart(10)} ${String(row.sampleRecords).padStart(12)}`
        );
    }

    if (!sourceRows.length) {
        console.log('(no crawler_sources records yet)');
    }

    console.log('\n=== Training samples by source ===');
    console.log(`${'Source'.padEnd(24)} ${'Count'.padStart(10)}`);
    console.log('-'.repeat(36));

    for (const row of sampleRows) {
        console.log(`${String(row._id).padEnd(24)} ${String(row.count).padStart(10)}`);
    }

    if (!sampleRows.length) {
        console.log('(no training_samples records yet)');
    }

    console.log('');
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

    if (process.argv.includes('--stats')) {
        await printStats();
        await db.disconnect();

        process.exit(0);
    }

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