const winston = require("winston");

module.exports = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ level, message, timestamp }) => {
            return `${timestamp} [${level.toUpperCase().padEnd(5)}] ${message}`;
        })
    ),
    transports: [new winston.transports.Console()],
});