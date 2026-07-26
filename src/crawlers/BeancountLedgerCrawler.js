const crypto = require('crypto');
const BaseCrawler = require('./BaseCrawler');
const logger = require('../logger');
const { TrainingSample } = require('../db/models');

/*
 * Well-known public plaintext-accounting ledgers.
 * `recurse: true` also scans one directory level down via the GitHub
 * contents API (for repos that nest ledgers in chapter/example subdirs).
 */
const CANDIDATE_REPOS = [
    {
        owner: 'beancount',
        repo: 'beancount',
        path: 'examples',
    },
    {
        owner: 'simonmichael',
        repo: 'hledger',
        path: 'examples',
        recurse: true,
    },
    {
        owner: 'adept',
        repo: 'full-fledged-hledger',
        path: '',
        recurse: true,
    },
    {
        owner: 'beancount',
        repo: 'fava',
        path: 'contrib/examples',
    },
    {
        owner: 'andreasgerstmayr',
        repo: 'fava-dashboards',
        path: 'example',
        recurse: true,
    },
    {
        owner: 'jbms',
        repo: 'beancount-import',
        path: 'testdata',
        recurse: true,
    },
    {
        owner: 'mckelvin',
        repo: 'beancount-boilerplate-cn',
        path: 'ledger',
        recurse: true,
    },
    {
        owner: 'deb-sig',
        repo: 'double-entry-generator',
        path: 'example',
        recurse: true,
    },
    {
        owner: 'trevorld',
        repo: 'r-ledger',
        path: 'inst/extdata',
    },
    {
        owner: 'wileykestner',
        repo: 'beancount-example',
        path: '',
    },
];

const BALANCE_TOLERANCE = 0.005;

const TXN_HEADER_REGEX = /^(\d{4}-\d{2}-\d{2})\s+[*!]\s+(.*)$/;
const POSTING_REGEX = /^\s+([A-Za-z][\w-]*(?::[\w-]+)+)\s*(?:([-+]?[\d,]*\.?\d+)\s+([A-Z][A-Z0-9'._-]*))?/;
const QUOTED_REGEX = /"((?:[^"\\]|\\.)*)"/g;

class BeancountLedgerCrawler extends BaseCrawler {
    constructor(options = {}) {
        super({
            delayMs: 1000,
            concurrency: 1,
            ...options,
        });
    }

    get name() {
        return 'BEANCOUNT_LEDGER';
    }

    async getWorkItems() {
        const items = [];

        for (const candidate of CANDIDATE_REPOS) {
            const entries = await this._listDirectory(candidate, candidate.path);

            const ledgerFiles = entries.filter(entry => this._isLedgerFile(entry));

            if (candidate.recurse) {
                const directories = entries.filter(entry => entry.type === 'dir');

                for (const directory of directories) {
                    const nested = await this._listDirectory(candidate, directory.path);
                    ledgerFiles.push(...nested.filter(entry => this._isLedgerFile(entry)));
                }
            }

            logger.info(
                `[BEANCOUNT_LEDGER] ${candidate.owner}/${candidate.repo}/${candidate.path || '.'}: ` +
                `${ledgerFiles.length} ledger files`
            );

            for (const file of ledgerFiles) {
                items.push({
                    ref: `BC_${candidate.owner}_${candidate.repo}_${file.path}`,
                    url: file.download_url,
                    repo: `${candidate.owner}/${candidate.repo}`,
                    path: file.path,
                });
            }
        }

        return items;
    }

    async _listDirectory(candidate, path) {
        const apiUrl =
            `https://api.github.com/repos/${candidate.owner}/${candidate.repo}` +
            `/contents/${path}`;

        try {
            const response = await this.fetch(apiUrl, {
                headers: {
                    Accept: 'application/vnd.github+json',
                    'User-Agent': 'duga-crawler',
                },
            });

            return Array.isArray(response.data)
                ? response.data
                : [response.data];
        } catch (exception) {
            logger.warn(
                `[BEANCOUNT_LEDGER] Listing failed for ${candidate.owner}/${candidate.repo}/${path}: ${exception.message}`
            );

            return [];
        }
    }

    _isLedgerFile(entry) {
        return entry.type === 'file' &&
            /\.(beancount|journal)$/i.test(entry.name) &&
            Boolean(entry.download_url);
    }

    async processItem(item) {
        const response = await this.fetch(item.url, {
            responseType: 'text',
        });

        const content = String(response.data);
        const sizeBytes = Buffer.byteLength(content, 'utf8');
        const sha256 = crypto
            .createHash('sha256')
            .update(content)
            .digest('hex');

        const lines = content.split('\n');
        const parsed = this._parseLedger(item.url, lines);

        const { insertedCount, duplicateCount } =
            await this._insertSamples(parsed.samples);

        logger.info(
            `[BEANCOUNT_LEDGER] ${item.path}: lines=${lines.length} ` +
            `inserted=${insertedCount} duplicates=${duplicateCount} ` +
            `skipped=${parsed.skipped} unbalanced=${parsed.unbalanced} ` +
            `withCost=${parsed.withCost}`
        );

        return {
            rawType: 'BEANCOUNT_LEDGER_METADATA',

            raw: {
                sourceUrl: item.url,
                sha256,
                sizeBytes,
                lineCount: lines.length,
                fetchedAt: new Date(),
                parseStats: {
                    inserted: insertedCount,
                    duplicates: duplicateCount,
                    skipped: parsed.skipped,
                    unbalanced: parsed.unbalanced,
                    withCost: parsed.withCost,
                },
            },

            samples: [],
            insertedCount,
        };
    }

    _parseLedger(fileUrl, lines) {
        const samples = [];
        let skipped = 0;
        let unbalanced = 0;
        let withCost = 0;

        let index = 0;
        while (index < lines.length) {
            const headerMatch = TXN_HEADER_REGEX.exec(lines[index]);

            if (!headerMatch) {
                index++;
                continue;
            }

            const headerLineNumber = index + 1;
            const txnDate = new Date(headerMatch[1]);
            const { payee, narration } = this._parsePayeeNarration(headerMatch[2]);

            const postings = [];
            let hasCostAnnotation = false;
            let cursor = index + 1;

            while (cursor < lines.length && /^\s+\S/.test(lines[cursor])) {
                if (
                    lines[cursor].includes('{') ||
                    lines[cursor].includes('}') ||
                    lines[cursor].includes('@@')
                ) {
                    hasCostAnnotation = true;
                }

                const postingMatch = POSTING_REGEX.exec(lines[cursor]);

                if (postingMatch) {
                    const amount = postingMatch[2] !== undefined
                        ? parseFloat(postingMatch[2].replace(/,/g, ''))
                        : null;

                    postings.push({
                        lineNumber: cursor + 1,
                        account: postingMatch[1],
                        amount: Number.isFinite(amount) ? amount : null,
                        currency: postingMatch[3] || null,
                    });
                } else {
                    skipped++;
                }

                cursor++;
            }

            if (!payee && !narration) {
                skipped += postings.length;
            } else if (hasCostAnnotation) {
                withCost++;
            } else if (!this._isBalanced(postings)) {
                unbalanced++;
            } else {
                const inferredLeg = this._inferMissingAmount(postings);

                for (const posting of postings) {
                    const isInferred =
                        inferredLeg !== null && inferredLeg.posting === posting;

                    const amount = isInferred ? inferredLeg.amount : posting.amount;
                    const currency = posting.currency ||
                        (isInferred ? inferredLeg.currency : null);

                    if (amount === null || !currency) {
                        skipped++;
                        continue;
                    }

                    const description = narration && payee
                        ? `${narration} - ${payee}`
                        : narration || payee;

                    samples.push({
                        description,
                        accountCode: posting.account,
                        accountLabel: this._humanizeAccount(posting.account),
                        counterpartyName: payee || undefined,
                        amount,
                        date: txnDate,
                        currency,
                        ...(isInferred ? { inferred: true } : {}),
                        source: 'BEANCOUNT_LEDGER',
                        sourceRef: crypto
                            .createHash('sha256')
                            .update(`${fileUrl}:${posting.lineNumber}`)
                            .digest('hex'),
                    });
                }
            }

            index = Math.max(cursor, headerLineNumber);
        }

        return { samples, skipped, unbalanced, withCost };
    }

    _parsePayeeNarration(rest) {
        const quoted = [];
        let match;

        QUOTED_REGEX.lastIndex = 0;
        while ((match = QUOTED_REGEX.exec(rest)) !== null) {
            quoted.push(match[1].trim());
        }

        if (quoted.length >= 2) {
            return { payee: quoted[0], narration: quoted[1] };
        }

        return { payee: null, narration: quoted[0] || null };
    }

    _isBalanced(postings) {
        if (postings.length < 2) return false;

        const missingAmount = postings.filter(
            posting => posting.amount === null || !posting.currency
        );

        /* Beancount auto-balances at most ONE posting per transaction. */
        if (missingAmount.length >= 2) return false;

        const sumsByCurrency = new Map();

        for (const posting of postings) {
            if (posting.amount === null || !posting.currency) {
                continue;
            }

            sumsByCurrency.set(
                posting.currency,
                (sumsByCurrency.get(posting.currency) || 0) + posting.amount
            );
        }

        if (missingAmount.length === 1) {
            /*
             * Infer the missing posting as the negative sum of the others.
             * Only possible when at most one currency has a non-zero sum.
             */
            const nonZeroCurrencies = [...sumsByCurrency.values()].filter(
                sum => Math.abs(sum) > BALANCE_TOLERANCE
            );

            return nonZeroCurrencies.length <= 1;
        }

        for (const sum of sumsByCurrency.values()) {
            if (Math.abs(sum) > BALANCE_TOLERANCE) {
                return false;
            }
        }

        return true;
    }

    /*
     * Beancount auto-balances at most one posting per transaction: a posting
     * with no amount. Infer it as the negative sum of the other postings,
     * but only when exactly one currency has a non-zero sum (same rule as
     * _isBalanced).
     */
    _inferMissingAmount(postings) {
        const missing = postings.filter(posting => posting.amount === null);

        if (missing.length !== 1) return null;

        const sumsByCurrency = new Map();

        for (const posting of postings) {
            if (posting.amount === null || !posting.currency) {
                continue;
            }

            sumsByCurrency.set(
                posting.currency,
                (sumsByCurrency.get(posting.currency) || 0) + posting.amount
            );
        }

        const nonZero = [...sumsByCurrency.entries()].filter(
            ([, sum]) => Math.abs(sum) > BALANCE_TOLERANCE
        );

        if (nonZero.length !== 1) return null;

        const [currency, sum] = nonZero[0];

        return { posting: missing[0], amount: -sum, currency };
    }

    _humanizeAccount(account) {
        const lastSegment = account.split(':').pop() || account;

        const humanized = lastSegment
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/[_-]+/g, ' ')
            .trim();

        return humanized.charAt(0).toUpperCase() + humanized.slice(1);
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

module.exports = BeancountLedgerCrawler;
