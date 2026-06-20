const mongoose = require("mongoose");
const logger = require("../logger")

async function connect() {
    const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/duga_crawler';
    await mongoose.connect(uri);
    logger.info(`MongoDB connected: ${uri}`);
}

async function disconnect() {
    await mongoose.disconnect();
    logger.info("Disconnected");
}

module.exports = {connect, disconnect};