var stream = require('stream');
var util = require('util');

function SaveLastKey() {
}

function createDeleteKeyWriteStream(opts) {
    var deleteStream = new stream.Writable({objectMode: true, highWaterMark: 10});
    deleteStream._write = function (c, e, n) {
        opts.db.del(c, {bucket: opts.bucket}, function (err) {
            n();
        });
        return false;
    };
    return deleteStream;
}

function createPrefixKeyReadStream(opts) {
    var stream;
    opts = opts || {};
    if (opts.reverse) {
        stream = opts.db.createKeyStream({
            start: opts.prefix + '~',
            end: opts.prefix,
            reverse: true,
            bucket: opts.bucket,
        });
    } else {
        stream = opts.db.createKeyStream({
            start: opts.prefix,
            end: opts.prefix + '~',
            bucket: opts.bucket,
        });
    }
    return stream;
}

function createRangeEntryReadStream(db, start, end, reverse, index) {
    var stream;
    if (reverse) {
        stream = db.createReadStream({
            start: end,
            end: start,
            index: index,
            reverse: true,
        });
    } else {
        stream = db.createReadStream({
            start: start,
            end: end,
            index: index,
        });
    }
    return stream;
}

function createIndexRangeEntryReadStream(opts) {
    var stream;
    if (opts.reverse) {
        stream = opts.db.createReadStream({
            start: opts.end,
            end: opts.start,
            index: opts.index,
            limit: opts.limit,
            continuation: opts.continuation,
            reverse: true,
            bucket: opts.bucket
        });
    } else {
        stream = opts.db.createReadStream({
            start: opts.start,
            end: opts.end,
            continuation: opts.continuation,
            limit: opts.limit,
            index: opts.index,
            bucket: opts.bucket
        });
    }
    return stream;
}

function createPrefixEntryReadStream(opts) {
    var outopts = {
        continuation: opts.continuation,
        bucket: opts.bucket,
        model: opts.model,
        index: opts.index,
        limit: opts.limit,
        reverse: opts.reverse
    };
    if (opts.reverse) {
        outopts.start = opts.prefix + '~';
        outopts.end = opts.prefix;
    } else {
        outopts.start = opts.prefix;
        outopts.end = opts.prefix + '~';
    }
    return opts.db.createReadStream(outopts);
}

function createIndexPrefixEntryReadStream(opts, db, prefix, reverse, index) {
    var stream;
    if (opts.reverse) {
        stream = opts.db.createReadStream({
            start: opts.prefix,
            end: opts.prefix,
            reverse: true,
            index: opts.index,
            continuation: opts.continuation,
            bucket: opts.bucket,
        });
    } else {
        stream = opts.db.createReadStream({
            start: opts.prefix,
            end: opts.prefix,
            index: opts.index,
            continuation: opts.continuation,
            bucket: opts.bucket,
        });
    }
    return stream;
}

function OnEachStream(onEach, opts) {
    this.onEach = onEach;
    opts = opts || {};
    if (!opts.highWaterMark) opts.highWaterMark = 5;
    if (!opts.hasOwnProperty('allowHalfOpen')) opts.allowHalfOpen = false;
    if (!opts.hasOwnProperty('objectMode')) opts.objectMode = true;
    stream.Transform.call(this, opts);
}

util.inherits(OnEachStream, stream.Transform);

(function () {
    this._transform = function (chunk, encoding, next) {
        this.onEach(chunk, function (err, result) {
            if (!err && result) {
                this.push(result);
            }
            next();
        }.bind(this));
    };
}).call(OnEachStream.prototype);


function EntryToModelStream(factory, parent, bucket, streamopts) {
    this.parent = parent;
    this.factory = factory;
    this.bucket = bucket;
    if (Array.isArray(this.bucket)) {
        this.bucket = this.bucket[0];
    }
    streamopts = streamopts || {};
    streamopts.highWaterMark = 10;
    streamopts.objectMode = true;
    streamopts.allowHalfOpen = false;
    stream.Transform.call(this, streamopts);
}

util.inherits(EntryToModelStream, stream.Transform);

(function () {
    this._transform = function (chunk, encoding, next) {
        var model = this.factory.create(chunk.value);
        model.__verymeta.extra = chunk.extra;
        if (this.parent) {
            model.__verymeta.parent = this.parent;
        }
        if (chunk.hasOwnProperty('extra') && typeof chunk.extra !== 'undefined' && chunk.extra.hasOwnProperty('vclock')) {
            model.vclock = chunk.extra.vclock;
        }
        model.key = chunk.key.substr(9);
        model.bucket = this.bucket;
        this.push(model);
        next();
    };
}).call(EntryToModelStream.prototype);

function OffsetCountStream(offset, count) {
    this.offset = offset;
    this.count = count || -1;
    this.size = 0;
    stream.Transform.call(this, {highWaterMark: 1, allowHalfOpen: false, objectMode: true});
}

util.inherits(OffsetCountStream, stream.Transform);

(function () {
    this._transform = function (chunk, encoding, next) {
        if (this.offset > 0) {
            this.offset -= 1;
        } else {
            this.push(chunk);
            this.size++;
            if (this.count !== -1 && this.size >= this.count) {
                this.push(null);
            }
        }
        next();
    };
    this.write = function () {
        if (this.count !== -1 && this.size >= this.count) {
            return false;
        }
        return stream.Transform.prototype.write.apply(this, arguments);
    };
}).call(OffsetCountStream.prototype);


function KeyValueGetStream(db) {
    stream.Transform.call(this, {highWaterMark: 10, allowHalfOpen: false, objectMode: true});
    this.db = db;
}

util.inherits(KeyValueGetStream, stream.Transform);

(function () {
    this._transform = function (entry, encoding, next) {
        var key = entry.value;
        this.db.get(key, function (err, value) {
            if (!err && value) {
                this.push({key: key, value: value});
            }
            next();
        }.bind(this));
    };
}).call(KeyValueGetStream.prototype);

function FilterModelStream(filter) {
    this.filter = filter;
    stream.Transform.call(this, {highWaterMark: 5, allowHalfOopen: false, objectMode: true});
}

util.inherits(FilterModelStream, stream.Transform);

(function () {
    this._transform = function (entry, encoding, next) {
        if (this.filter(entry)) {
            this.push(entry);
        }
        next();
    };
}).call(FilterModelStream.prototype);

function deleteKeysWithPrefix(opts, callback) {
    createPrefixKeyReadStream(opts).pipe(createDeleteKeyWriteStream(opts))
        .on('finish', callback);
}

module.exports = {
    createDeleteKeyWriteStream: createDeleteKeyWriteStream,
    createPrefixKeyReadStream: createPrefixKeyReadStream,
    deleteKeysWithPrefix: deleteKeysWithPrefix,
    createPrefixEntryReadStream: createPrefixEntryReadStream,
    EntryToModelStream: EntryToModelStream,
    OffsetCountStream: OffsetCountStream,
    KeyValueGetStream: KeyValueGetStream,
    OnEachStream: OnEachStream,
    FilterModelStream: FilterModelStream,
    createRangeEntryReadStream: createRangeEntryReadStream,
    createIndexRangeEntryReadStream: createIndexRangeEntryReadStream,
    createIndexPrefixEntryReadStream: createIndexPrefixEntryReadStream,
};
