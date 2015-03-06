// Cannot declare 'use strict' here, because queryResult
// needs to be exported into the global namespace.

var npm = {
    promise: require('promise'),
    pg: require('pg')
};

///////////////////////////////////////////////////////
// Query Result Mask flags;
//
// Any combination is supported, except for one + many.
queryResult = {
    one: 1,     // single-row result is expected;
    many: 2,    // multi-row result is expected;
    none: 4     // no rows expected.
};

////////////////////////////////////////////////
// Main entry function;
//
// Parameters:
//
// options (optional) -
// {
//    connect: function(client){
//        on-connect event;
//        client - pg connection object.
//    },
//    disconnect: function(client){
//        on-disconnect event;
//        client - pg connection object.
//    }
// }
module.exports = function (options) {

    var lib = function (cn) {
        if (!$isEmptyObject(this)) {
            // This makes it easy to locate the most common mistake -
            // skipping keyword 'new' when calling: var db = new pgp(cn);
            throw new Error("Invalid database object instantiation.");
        }
        if (!cn) {
            throw new Error("Invalid 'cn' parameter passed.");
        }
        return dbInit(this, cn, options);
    };

    // Namespace for type conversion helpers;
    lib.as = $wrap;

    // Exposing PG library instance, just for flexibility.
    lib.pg = npm.pg;

    // Terminates pg library; call it when exiting the application.
    lib.end = function () {
        npm.pg.end();
    };

    return lib;
};

function dbInit(dbInst, cn, options) {

    // Handles database connection acquire/release
    // events, notifying the client as needed.
    function monitor(open, db) {
        if (open) {
            if (options) {
                var func = options.connect;
                if (func) {
                    if (typeof(func) !== 'function') {
                        throw new Error('Function was expected for options.connect');
                    }
                    func(db.client); // notify the client;
                }
            }
        } else {
            if (options) {
                var func = options.disconnect;
                if (func) {
                    if (typeof(func) !== 'function') {
                        throw new Error('Function was expected for options.disconnect');
                    }
                    func(db.client); // notify the client;
                }
            }
            db.done(); // release database connection back to the pool;
        }
    }

    /////////////////////////////////////////////////////////////////
    // Connects to the database;
    // The caller must invoke done() after all requests are finished.
    dbInst.connect = function () {
        return $p(function (resolve, reject) {
            npm.pg.connect(cn, function (err, client, done) {
                if (err) {
                    reject(err);
                } else {
                    resolve({
                        client: client,
                        done: done
                    });
                }
            });
        });
    };

    //////////////////////////////////////////////////////////////
    // Generic query request;
    // qrm is Query Result Mask, combination of queryResult flags.
    dbInst.query = function (query, qrm, values) {
        return $p(function (resolve, reject) {
            dbInst.connect()
                .then(function (db) {
                    monitor(true, db);
                    $query(db.client, query, qrm, values)
                        .then(function (data) {
                            monitor(false, db);
                            resolve(data);
                        }, function (reason) {
                            monitor(false, db);
                            reject(reason);
                        });
                }, function (reason) {
                    reject(reason); // connection failed;
                });
        });
    };

    dbInst.none = function (query, values) {
        return dbInst.query(query, queryResult.none, values);
    };

    dbInst.one = function (query, values) {
        return dbInst.query(query, queryResult.one, values);
    };

    dbInst.many = function (query, values) {
        return dbInst.query(query, queryResult.many, values);
    };

    dbInst.oneOrNone = function (query, values) {
        return dbInst.query(query, queryResult.one | queryResult.none, values);
    };

    dbInst.manyOrNone = function (query, values) {
        return dbInst.query(query, queryResult.many | queryResult.none, values);
    };

    // TODO: Review the parameters
    dbInst.func = function (funcName, params, qrm) {
        var query = $createFuncQuery(funcName, params);
        if (qrm) {
            return dbInst.query(query, qrm);
        } else {
            return dbInst.one(query);
        }
    };

    // TODO: Review the parameters
    dbInst.proc = function (procName, params) {
        return dbInst.oneOrNone($createFuncQuery(procName, params));
    };

    //////////////////////////
    // Transaction class;
    dbInst.tx = function () {

        var tx = this;

        if (!$isEmptyObject(tx)) {
            // This makes it easy to locate the most common mistake -
            // skipping keyword 'new' when calling: var tx = new db.tx(cn);
            throw new Error("Invalid transaction object instantiation.");
        }

        var local = {
            db: null,
            start: function (db) {
                this.db = db;
                monitor(true, db);
            },
            finish: function () {
                monitor(false, this.db);
                this.db = null;
            },
            call: function (cb) {
                if (typeof(cb) !== 'function') {
                    return npm.promise.reject("Cannot invoke tx.exec() without a callback function.");
                }
                var result = cb(this.db.client);
                if (result && typeof(result.then) === 'function') {
                    return result;
                } else {
                    return npm.promise.reject("Callback function passed into tx.exec() didn't return a valid promise object.");
                }
            }
        };

        // Executes transaction;
        tx.exec = function (cb) {
            if (local.db) {
                throw new Error("Previous call to tx.exec() hasn't finished.");
            }
            var t_data, t_reason, success;
            return $p(function (resolve, reject) {
                dbInst.connect()
                    .then(function (db) {
                        local.start(db);
                        return tx.query('begin', queryResult.none);
                    }, function (reason) {
                        reject(reason); // connection issue;
                    })
                    .then(function () {
                        local.call(cb)
                            .then(function (data) {
                                t_data = data;
                                success = true;
                                return tx.query('commit', queryResult.none);
                            }, function (reason) {
                                t_reason = reason;
                                success = false;
                                return tx.query('rollback', queryResult.none);
                            })
                            .then(function () {
                                local.finish();
                                // either commit or rollback successfully executed;
                                if (success) {
                                    resolve(t_data);
                                } else {
                                    reject(t_reason);
                                }
                            }, function (reason) {
                                // either commit or rollback failed;
                                local.finish();
                                reject(reason);
                            });
                    }, function (reason) {
                        local.finish();
                        reject(reason); // issue with 'begin' command;
                    });
            });
        };

        tx.query = function (query, qrm, values) {
            if (!local.db) {
                throw new Error('Unexpected call outside of transaction');
            }
            return $query(local.db.client, query, qrm, values);
        };

        tx.none = function (query, values) {
            return tx.query(query, queryResult.none, values);
        };

        tx.one = function (query, values) {
            return tx.query(query, queryResult.one, values);
        };

        tx.many = function (query, values) {
            return tx.query(query, queryResult.many, values);
        };

        tx.oneOrNone = function (query, values) {
            return tx.query(query, queryResult.one | queryResult.none, values);
        };

        tx.manyOrNone = function (query, values) {
            return tx.query(query, queryResult.many | queryResult.none, values);
        };

        // TODO: Review the parameters
        tx.func = function (funcName, params, qrm) {
            var query = $createFuncQuery(funcName, params);
            if (qrm) {
                return tx.query(query, qrm);
            } else {
                return tx.one(query);
            }
        };

        // TODO: Review the parameters
        tx.proc = function (procName, params) {
            return tx.oneOrNone($createFuncQuery(procName, params));
        };
    };
}

////////////////////////////////////////////////
// Global, reusable functions, all start with $

// Simpler promise instantiation;
function $p(func) {
    return new npm.promise(func);
}

// Null verification;
function $isNull(val) {
    return typeof(val) === 'undefined' || val === null;
}

// Checks if the object is empty (has no properties);
function $isEmptyObject(obj) {
    return Object.keys(obj).length === 0;
}

// Fixes single-quote symbols in text fields;
function $fixQuotes(val) {
    return val.replace("'", "''");
}

// Wraps up text in single quotes;
function $wrapText(text) {
    return "'" + text + "'";
}

// Translates a javascript value into its text presentation,
// according to the type, compatible with PostgreSQL format.
// TODO: Add check for types that are not simple: Object, Array, Function
function $wrapValue(val) {
    if ($isNull(val)) {
        return 'null';
    }
    switch (typeof(val)) {
        case 'string':
            return $wrap.text(val);
        case 'boolean':
            return $wrap.bool(val);
        default:
            if (val instanceof Date) {
                return $wrap.date(val);
            } else {
                return val;
            }
    }
}

// Formats array of javascript-type values into a list of
// parameters for a function call, compatible with PostgreSQL.
function $formatValues(values) {
    var s = '';
    if (Array.isArray(values) && values.length > 0) {
        for (var i = 0; i < values.length; i++) {
            if (i > 0) {
                s += ',';
            }
            s += $wrapValue(values[i]);
        }
    }
    return s;
}

// Value wrapper to be exposed through 'pgp.as' namespace;
var $wrap = {
    text: function (txt) {
        if ($isNull(txt)) {
            return 'null';
        }
        return $wrapText($fixQuotes(txt));
    },
    bool: function (val) {
        if ($isNull(val)) {
            return 'null';
        }
        return val ? 'TRUE' : 'FALSE';
    },
    date: function (d) {
        if ($isNull(d)) {
            return 'null';
        }
        if (d instanceof Date) {
            return $wrapText(d.toUTCString());
        } else {
            throw new Error($wrapText(d) + " doesn't represent a valid Date object or value");
        }
    },
    csv: function (arr) {
        if ($isNull(arr)) {
            return 'null';
        }
        if (Array.isArray(arr)) {
            return $formatValues(arr);
        } else {
            throw new Error($wrapText(arr) + " doesn't represent a valid Array object or value");
        }
    }
};

// Formats a proper function call from the parameters.
function $createFuncQuery(funcName, params) {
    return 'select * from ' + funcName + '(' + $formatValues(params) + ');';
}

// Parses query for $1, $2,... variables and
// replaces them with the values passed.
// values can be an array of simple values, or just one value.
// TODO: Add check for types that are not simple: Object, Array, Function
function $parseValues(query, values) {
    var q = query;
    var result = {
        success: true
    };
    if (values) {
        if (Array.isArray(values) && values.length > 0) {
            for (var i = 0; i < values.length; i++) {
                var variable = '$' + (i + 1);
                if (q.indexOf(variable) === -1) {
                    result.success = false;
                    result.error = 'More values passed than variables in the query';
                    break;
                } else {
                    var value = $wrapValue(values[i]);
                    q = q.replace(variable, value);
                }
            }
        }else{
            var variable = '$1';
            if (q.indexOf(variable) === -1){
                result.success = false;
                result.error = 'No variable found in query to replace with the value passed';
            }else {
                q = q.replace(variable, $wrapValue(values));
            }
        }
    }
    if(result.success){
        result.query = q;
    }
    return result;
}

// Generic, static query call for the specified connection + query + result.
function $query(client, query, qrm, values) {
    return $p(function (resolve, reject) {
        var errMsg, req;
        if (!query) {
            errMsg = "Invalid query specified";
        } else {
            var badMask = queryResult.one | queryResult.many;
            if (!qrm || (qrm & badMask) === badMask) {
                errMsg = "Invalid Query Result Mask specified";
            } else {
                req = $parseValues(query, values);
                if (!req.success) {
                    errMsg = req.error;
                }
            }
        }
        if (errMsg) {
            reject(errMsg);
        } else {
            client.query(req.query, function (err, result) {
                if (err) {
                    reject(err.message);
                } else {
                    var data = result.rows;
                    var l = result.rows.length;
                    if (l) {
                        if (l > 1 && !(qrm & queryResult.many)) {
                            reject("Single row was expected from query: '" + query + "'");
                        } else {
                            if (!(qrm & queryResult.many)) {
                                data = result.rows[0];
                            }
                        }
                    } else {
                        if (qrm & queryResult.none) {
                            data = (qrm & queryResult.many) ? [] : null;
                        } else {
                            reject("No rows returned from query: '" + query + "'");
                        }
                    }
                    resolve(data);
                }
            });
        }
    });
}
