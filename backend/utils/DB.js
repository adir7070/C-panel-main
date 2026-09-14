
/**
 * MongoDB Database Wrapper Class
 * Primary: AWS EC2 (local, fast)
 * Fallback: Atlas — always written to simultaneously with primary
 * All failure events are logged to db_fallback_logs and the app logger.
 */
class DB {
  constructor() {
    this._db = null;
    this._fallbackDb = null;
  }

  /**
   * @param {Object} primaryDb   - AWS EC2 MongoDB instance
   * @param {Object} [fallbackDb] - Atlas MongoDB instance (optional)
   */
  init(primaryDb, fallbackDb = null) {
    this._db = primaryDb;
    this._fallbackDb = fallbackDb;
  }

  // ── Internal: log a fallback event to Atlas (fire-and-forget) ────────────
  _logFallback(operation, collectionName, errorMessage, queryHint = null) {
    const entry = {
      timestamp: new Date(),
      operation,
      collection: collectionName,
      error: errorMessage,
      query: queryHint ? JSON.stringify(queryHint).substring(0, 300) : null,
    };

    console.warn(
      `[DB-FALLBACK] ${operation} on "${collectionName}" failed on primary → using Atlas. Error: ${errorMessage}`,
    );

    // Persist to Atlas directly (skip the wrapper to avoid recursion)
    const logCol = this._fallbackDb
      ? this._fallbackDb.collection("db_fallback_logs")
      : this._db
        ? this._db.collection("db_fallback_logs")
        : null;

    if (logCol) {
      logCol.insertOne(entry).catch((err) =>
        console.error("[DB-FALLBACK] Failed to write fallback log:", err.message),
      );
    }
  }

  // ── Internal: mirror write to fallback (fire-and-forget) ─────────────────
  _mirror(fallbackCol, op, ...args) {
    if (!fallbackCol) return;
    fallbackCol[op](...args).catch((err) =>
      console.error(`[DB-MIRROR] ${op} on fallback failed:`, err.message),
    );
  }

  /**
   * Get a collection wrapper.
   * Reads:  try primary → on error → fallback + log
   * Writes: try primary → on error → fallback + log; on success → mirror to fallback
   */
  collection(collectionName) {
    if (!this._db) {
      const err = new Error('Database not ready. Please try again in a moment.');
      err.code = 'DB_NOT_INITIALIZED';
      console.error(`[DB] collection("${collectionName}") called before DB.init()`);
      throw err;
    }

    const col = this._db.collection(collectionName);
    const fallbackCol = this._fallbackDb
      ? this._fallbackDb.collection(collectionName)
      : null;

    const self = this;

    // Wrap a read operation with fallback
    const withReadFallback = async (op, hint, ...args) => {
      try {
        return await col[op](...args);
      } catch (err) {
        if (fallbackCol) {
          self._logFallback(op, collectionName, err.message, hint);
          return fallbackCol[op](...args);
        }
        throw err;
      }
    };

    // Wrap a write operation — writes to BOTH DBs simultaneously and waits for both
    const withWriteFallback = async (op, hint, ...args) => {
      if (!fallbackCol) {
        return col[op](...args);
      }

      const [primaryResult, fallbackResult] = await Promise.allSettled([
        col[op](...args),
        fallbackCol[op](...args),
      ]);

      const primaryOk  = primaryResult.status  === 'fulfilled';
      const fallbackOk = fallbackResult.status === 'fulfilled';

      if (!primaryOk && !fallbackOk) {
        const errMsg = `DB write failed on both: ${primaryResult.reason?.message}`;
        self._logFallback(op, collectionName, errMsg, hint);
        throw primaryResult.reason;
      }

      if (!primaryOk) {
        const msg = `write "${op}" on "${collectionName}" failed on AWS: ${primaryResult.reason?.message}`;
        console.error('[DB-WRITE]', msg);
        self._logFallback(op, collectionName, `primary failed: ${primaryResult.reason?.message}`, hint);
      }

      if (!fallbackOk) {
        const msg = `write "${op}" on "${collectionName}" failed on Atlas: ${fallbackResult.reason?.message}`;
        console.error('[DB-WRITE]', msg);
        self._logFallback(op, collectionName, `atlas failed: ${fallbackResult.reason?.message}`, hint);
      }

      return primaryOk ? primaryResult.value : fallbackResult.value;
    };

    return {
      // ── Reads ─────────────────────────────────────────────────────────────

      /**
       * findOne:
       *  - AWS error           → Atlas + log (connection error)
       *  - AWS returns null    → check Atlas:
       *      Atlas has doc     → return Atlas doc + log (sync gap)
       *      Atlas also null   → return null (legitimate "not found")
       *  - AWS returns doc     → return it
       */
      findOne: async (query, options) => {
        let awsResult;
        try {
          awsResult = await col.findOne(query, options);
        } catch (err) {
          if (fallbackCol) {
            self._logFallback("findOne", collectionName, `AWS error: ${err.message}`, query);
            return fallbackCol.findOne(query, options);
          }
          throw err;
        }

        if (awsResult !== null && awsResult !== undefined) return awsResult;

        // AWS returned null — check Atlas to detect sync gaps
        if (fallbackCol) {
          const atlasResult = await fallbackCol.findOne(query, options).catch(() => null);
          if (atlasResult !== null && atlasResult !== undefined) {
            self._logFallback(
              "findOne",
              collectionName,
              "sync_gap: doc exists in Atlas but not in AWS",
              query,
            );
            // Read repair: write the missing doc back to AWS (fire-and-forget)
            col.replaceOne({ _id: atlasResult._id }, atlasResult, { upsert: true }).catch((err) =>
              console.error(`[READ-REPAIR] Failed to repair "${collectionName}":`, err.message),
            );
            return atlasResult;
          }
        }

        return null; // not found in either → legitimate
      },

      find: (query, options) => {
        // find() returns a cursor — fallback only on connection error
        try {
          return col.find(query, options);
        } catch (err) {
          if (fallbackCol) {
            self._logFallback("find", collectionName, `AWS error: ${err.message}`, query);
            return fallbackCol.find(query, options);
          }
          throw err;
        }
      },

      countDocuments: (query, options) =>
        withReadFallback("countDocuments", query, query, options),

      estimatedDocumentCount: (options) =>
        withReadFallback("estimatedDocumentCount", null, options),

      aggregate: (pipeline, options) => {
        try {
          return col.aggregate(pipeline, options);
        } catch (err) {
          if (fallbackCol) {
            self._logFallback("aggregate", collectionName, `AWS error: ${err.message}`, pipeline?.[0]);
            return fallbackCol.aggregate(pipeline, options);
          }
          throw err;
        }
      },

      // ── Writes (primary → fallback on error, mirror on success) ──────────
      insertOne: (doc, options) =>
        withWriteFallback("insertOne", null, doc, options),

      insertMany: (docs, options) =>
        withWriteFallback("insertMany", null, docs, options),

      updateOne: (filter, update, options) =>
        withWriteFallback("updateOne", filter, filter, update, options),

      updateMany: (filter, update, options) =>
        withWriteFallback("updateMany", filter, filter, update, options),

      findOneAndUpdate: (filter, update, options) =>
        withWriteFallback("findOneAndUpdate", filter, filter, update, options),

      deleteOne: (filter, options) =>
        withWriteFallback("deleteOne", filter, filter, options),

      deleteMany: (filter, options) =>
        withWriteFallback("deleteMany", filter, filter, options),

      replaceOne: (filter, replacement, options) =>
        withWriteFallback("replaceOne", filter, filter, replacement, options),

      bulkWrite: (operations, options) =>
        withWriteFallback("bulkWrite", null, operations, options),

      // ── Index operations (primary only) ──────────────────────────────────
      createIndex: (keys, options) => col.createIndex(keys, options),
      createIndexes: (indexes, options) => col.createIndexes(indexes, options),
      dropIndex: (indexName, options) => col.dropIndex(indexName, options),

      // ── Raw access ────────────────────────────────────────────────────────
      raw: () => col,
    };
  }

  // ── Cross-server merge reads ──────────────────────────────────────────────

  async findMergedChat(chatId) {
    const primaryCol = this._db?.collection('support_chats');
    const fallbackCol = this._fallbackDb?.collection('support_chats');

    const [primary, fallback] = await Promise.allSettled([
      primaryCol?.findOne({ _id: chatId }),
      fallbackCol?.findOne({ _id: chatId }),
    ]);

    const a = primary.status === 'fulfilled' ? primary.value : null;
    const b = fallback.status === 'fulfilled' ? fallback.value : null;

    if (!a && !b) return null;
    if (!a) return b;
    if (!b) return a;

    const msgMap = new Map();
    [...(a.messages || []), ...(b.messages || [])].forEach(m => {
      msgMap.set(String(m._id), m);
    });
    const mergedMessages = [...msgMap.values()].sort((x, y) => x._id - y._id);
    const base = (a.updated_at >= b.updated_at) ? a : b;
    return { ...base, messages: mergedMessages };
  }

  async findMergedRecentChats(daysBack = 3) {
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const primaryCol = this._db?.collection('support_chats');
    const fallbackCol = this._fallbackDb?.collection('support_chats');

    const query = {
      updated_at: { $gte: since },
      status: { $ne: 'merged' },
      $or: [{ 'messages.fromRole': 'user' }, { 'messages.fromRole': 'agent' }, { agentInitiated: true }],
    };

    const [primaryChats, fallbackChats] = await Promise.allSettled([
      primaryCol?.find(query).sort({ updated_at: -1 }).project({ messages: { $slice: -20 } }).toArray(),
      fallbackCol?.find(query).sort({ updated_at: -1 }).project({ messages: { $slice: -20 } }).toArray(),
    ]);

    const aList = primaryChats.status === 'fulfilled' ? primaryChats.value || [] : [];
    const bList = fallbackChats.status === 'fulfilled' ? fallbackChats.value || [] : [];

    const chatMap = new Map();
    aList.forEach(c => chatMap.set(String(c._id), c));
    bList.forEach(c => {
      const existing = chatMap.get(String(c._id));
      if (!existing) {
        chatMap.set(String(c._id), c);
      } else {
        const msgMap = new Map();
        [...(existing.messages || []), ...(c.messages || [])].forEach(m => {
          msgMap.set(String(m._id), m);
        });
        const mergedMessages = [...msgMap.values()].sort((x, y) => x._id - y._id);
        const base = (existing.updated_at >= c.updated_at) ? existing : c;
        chatMap.set(String(c._id), { ...base, messages: mergedMessages });
      }
    });

    return [...chatMap.values()].sort((a, b) => b.updated_at - a.updated_at);
  }

  isInitialized() {
    return this._db !== null;
  }

  getDB() {
    if (!this._db) throw new Error("Database not initialized. Call DB.init() first.");
    return this._db;
  }
}

module.exports = new DB();
