const mongoose = require("mongoose");

const crawlerSourceSchema = new mongoose.Schema({
    crawlerName: { type: String, required: true },
    sourceRef:   { type: String, required: true },
    sourceUrl:   String,
    status:      { type: String, enum: ['IN_PROGRESS', 'SUCCESS', 'FAILED'], default: 'IN_PROGRESS' },
    recordsRaw:      { type: Number, default: 0 },
    recordsSamples:  { type: Number, default: 0 },
    errorMessage:    String,
    fetchedAt:   { type: Date, default: Date.now },
}, {collection : "crawler_sources"});

crawlerSourceSchema.index({
    crawlerName: 1,
    sourceRef: 1,
}, {unique: true});

const rawDocumentSchema = new mongoose.Schema({
    crawlerName: { type: String, required: true },
    sourceRef:   { type: String, required: true },
    rawType:     String,
    payload:     mongoose.Schema.Types.Mixed,
    normalised:  { type: Boolean, default: false },
    createdAt:   { type: Date, default: Date.now },
}, { collection: 'raw_documents' });

rawDocumentSchema.index({ crawlerName: 1, sourceRef: 1 });
rawDocumentSchema.index({ normalised: 1 });

// FUR KI
const trainingSampleSchema = new mongoose.Schema({
    description:      { type: String, required: true },
    accountCode:      { type: String, required: true },
    accountLabel:     String,
    counterpartyName: String,
    country:          String,
    currency:         String,
    taxRate:          Number,
    source:           { type: String, required: true },
    sourceRef:        String,
    confidence:       { type: Number, default: 0.8 },
    createdAt:        { type: Date, default: Date.now },
}, { collection: 'training_samples' });

trainingSampleSchema.index({
    source: 1,
    sourceRef: 1
}, { unique: true, sparse: true });

trainingSampleSchema.index({ accountCode: 1 });
trainingSampleSchema.index({ country: 1 });

module.exports = {
    CrawlerSource: mongoose.model("CrawlerSource", crawlerSourceSchema),
    RawDocument: mongoose.model("RawDocument", rawDocumentSchema),
    TrainingSample: mongoose.model("TrainingSample", trainingSampleSchema),
}