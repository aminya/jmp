#!/usr/bin/env node

/*
 * BSD 3-Clause License
 *
 * Copyright (c) 2015, Nicolas Riesco and others as credited in the AUTHORS file
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 * this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 * this list of conditions and the following disclaimer in the documentation
 * and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 * may be used to endorse or promote products derived from this software without
 * specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 *
 */

/**
 * @module jmp
 *
 * @description Module `jmp` provides functionality for creating, parsing and
 * replying to messages of the Jupyter protocol. It also provides functionality
 * for networking these messages via {@link module:zmq~Socket ZMQ sockets}.
 *
 */
module.exports = {
    Message: Message,
    Socket: Socket,

    /**
     * ZeroMQ bindings
     */
    zmq: require("zmq"),
};

var DEBUG = global.DEBUG || false;
var DELIMITER = '<IDS|MSG>';

var console = require("console");
var crypto = require("crypto");
var uuid = require("node-uuid");
var zmq = module.exports.zmq;

/**
 * Jupyter message
 * @class
 * @param          [properties]              Message properties
 * @param {Array}  [properties.idents]       ZMQ identities
 * @param {Object} [properties.header]
 * @param {Object} [properties.parentHeader]
 * @param {Object} [properties.metadata]
 * @param {Object} [properties.content]
 */
function Message(properties) {
    /**
     * ZMQ identities
     * @member {Array}
     */
    this.idents = properties && properties.idents || [];

    /**
     * @member {Object}
     */
    this.header = properties && properties.header || {};

    /**
     * @member {Object}
     */
    this.parentHeader = properties && properties.parentHeader || {};

    /**
     * @member {Object}
     */
    this.metadata = properties && properties.metadata || {};

    /**
     * @member {Object}
     */
    this.content = properties && properties.content || {};

    /**
     * Unparsed JMP message frames (any frames after content)
     * @member {Object}
     */
    this.blobs = properties && properties.blobs || [];

    /**
     * Validity of message signature
     * (only set for messages received on JMP sockets)
     * @member {?Boolean}
     */
    this.signatureOK = null;
}

/**
 * Send a response
 *
 * @param {module:zmq~Socket} socket Socket over which the response is sent
 * @param {String} messageType       Jupyter response message type
 * @param {Object} [content]         Jupyter response content
 * @param {Object} [metadata]        Jupyter response metadata
 * @param {String} [protocolVersion] Jupyter protocol version
 */
Message.prototype.respond = function(
    socket, messageType, content, metadata, protocolVersion
) {
    var response = new Message();

    response.idents = this.idents;

    response.header = {
        msg_id: uuid.v4(),
        username: this.header.username,
        session: this.header.session,
        msg_type: messageType,
    };
    if (this.header && this.header.version) {
        response.header.version = this.header.version;
    }
    if (protocolVersion) {
        response.header.version = protocolVersion;
    }

    response.parentHeader = this.header;
    response.content = content || {};
    response.metadata = metadata || {};

    socket.send(response);
};

/**
 * Decode message received over a ZMQ socket
 *
 * @param {argsArray} messageFrames    argsArray of a message listener on a JMP
 *                                     socket
 * @param {String}    [scheme=sha256]  Hashing scheme
 * @param {String}    [key=""]         Hashing key
 * @returns {module:jmp~Message} `this` to allow chaining
 * @protected
 */
Message.prototype._decode = function(messageFrames, scheme, key) {
    scheme = scheme || "sha256";
    key = key || "";

    var i = 0;
    this.idents = [];
    for (i = 0; i < messageFrames.length; i++) {
        var part = messageFrames[i];
        if (part.toString() === DELIMITER) {
            break;
        }
        this.idents.push(part);
    }
    if (messageFrames.length - i < 5) {
        console.error(
            "JMP: MESSAGE: DECODE: Not enough message frames", messageFrames
        );
        return;
    }
    if (messageFrames[i].toString() !== DELIMITER) {
        console.error(
            "JMP: MESSAGE: DECODE: Missing delimiter", messageFrames
        );
        return;
    }

    if (key) {
        var obtainedSignature = messageFrames[i + 1].toString();

        var hmac = crypto.createHmac(scheme, key);
        hmac.update(messageFrames[i + 2]);
        hmac.update(messageFrames[i + 3]);
        hmac.update(messageFrames[i + 4]);
        hmac.update(messageFrames[i + 5]);
        var expectedSignature = hmac.digest("hex");

        this.signatureOK = (expectedSignature === obtainedSignature);
        if (!this.signatureOK) {
            console.error(
                "JMP: MESSAGE: DECODE: Incorrect message signature:",
                "Obtained = " + obtainedSignature,
                "Expected = " + expectedSignature
            );

            return;
        }
    }

    this.header = toJSON(messageFrames[i + 2]);
    this.parentHeader = toJSON(messageFrames[i + 3]);
    this.content = toJSON(messageFrames[i + 5]);
    this.metadata = toJSON(messageFrames[i + 4]);
    this.blobs = Array.prototype.slice.apply(messageFrames, [i + 6]);

    function toJSON(value) {
        return JSON.parse(value.toString());
    }
};

/**
 * Encode message for transfer over a ZMQ socket
 *
 * @param {String} [scheme=sha256] Hashing scheme
 * @param {String} [key=""]        Hashing key
 * @returns {Array} Encoded message
 * @protected
 */
Message.prototype._encode = function(scheme, key) {
    scheme = scheme || "sha256";
    key = key || "";

    var idents = this.idents;

    var header = JSON.stringify(this.header);
    var parentHeader = JSON.stringify(this.parentHeader);
    var metadata = JSON.stringify(this.metadata);
    var content = JSON.stringify(this.content);

    var signature = '';
    if (key) {
        var hmac = crypto.createHmac(scheme, key);
        var encoding = "utf8";
        hmac.update(new Buffer(header, encoding));
        hmac.update(new Buffer(parentHeader, encoding));
        hmac.update(new Buffer(metadata, encoding));
        hmac.update(new Buffer(content, encoding));
        signature = hmac.digest("hex");
    }

    var response = idents.concat([ // idents
        DELIMITER, // delimiter
        signature, // HMAC signature
        header, // header
        parentHeader, // parent header
        metadata, // metadata
        content, // content
    ]);

    return response;
};

/**
 * @class
 * @classdesc ZMQ socket that parses the Jupyter Messaging Protocol
 *
 * @param {String|Number} socketType ZMQ socket type
 * @param {String} [scheme="sha256"] Hashing scheme
 * @param {String} [key=""] Hashing key
 */
function Socket(socketType, scheme, key) {
    zmq.Socket.call(this, socketType);
    this._jmp = {
        scheme: scheme,
        key: key,
        _listeners: [],
    };
}

Socket.prototype = Object.create(zmq.Socket.prototype);
Socket.prototype.constructor = Socket;

/**
 * Send the given message.
 *
 * @param {module:jmp~Message|String|Buffer|Array} message
 * @param {Number} flags
 * @returns {module:jmp~Socket} `this` to allow chaining
 *
 */
Socket.prototype.send = function(message, flags) {
    var p = Object.getPrototypeOf(Socket.prototype);

    if (message instanceof Message) {
        if (DEBUG) console.log("JMP: SOCKET: SEND: MESSAGE:", message);

        return p.send.call(
            this, message._encode(this._jmp.scheme, this._jmp.key), flags
        );
    }

    return p.send.apply(this, arguments);
};

/**
 * Add listener to the end of the listeners array for the specified event
 *
 * @param {String} event
 * @param {Function} listener
 * @returns {module:jmp~Socket} `this` to allow chaining
 */
Socket.prototype.on = function(event, listener) {
    var p = Object.getPrototypeOf(Socket.prototype);

    if (event !== "message") {
        return p.on.apply(this, arguments);
    }

    var _listener = {
        unwrapped: listener,
        wrapped: (function() {
            var message = new Message();
            message._decode(arguments, this._jmp.scheme, this._jmp.key);
            listener(message);
        }).bind(this),
    };
    this._jmp._listeners.push(_listener);
    return p.on.call(this, event, _listener.wrapped);
};

/**
 * Add listener to the end of the listeners array for the specified event
 *
 * @param {String} event
 * @param {Function} listener
 * @returns {module:jmp~Socket} `this` to allow chaining
 */
Socket.prototype.addListener = Socket.prototype.on;

/**
 * Add a one-time listener to the end of the listeners array for the specified
 * event
 *
 * @param {String} event
 * @param {Function} listener
 * @returns {module:jmp~Socket} `this` to allow chaining
 */
Socket.prototype.once = function(event, listener) {
    var p = Object.getPrototypeOf(Socket.prototype);

    if (event !== "message") {
        return p.once.apply(this, arguments);
    }

    return p.once.call(this, event, (function() {
        var message = new Message();
        message._decode(arguments, this._jmp.scheme, this._jmp.key);
        listener(message);
    }).bind(this));
};

/**
 * Remove listener from the listeners array for the specified event
 *
 * @param {String} event
 * @param {Function} listener
 * @returns {module:jmp~Socket} `this` to allow chaining
 */
Socket.prototype.removeListener = function(event, listener) {
    var p = Object.getPrototypeOf(Socket.prototype);

    if (event !== "message") {
        return p.removeListener.apply(this, arguments);
    }

    var length = this._jmp._listeners.length;
    for (var i = 0; i < length; i++) {
        var _listener = this._jmp._listeners[i];
        if (_listener.unwrapped === listener) {
            this._jmp._listeners.splice(i, 1);
            return p.removeListener.call(this, event, _listener.wrapped);
        }
    }

    return p.removeListener.apply(this, arguments);
};

/**
 * Remove all listeners, or those for the specified event
 *
 * @param {String} [event]
 * @returns {module:jmp~Socket} `this` to allow chaining
 */
Socket.prototype.removeAllListeners = function(event) {
    var p = Object.getPrototypeOf(Socket.prototype);

    if (arguments.length === 0 || event === "message") {
        this._jmp._listeners.length = 0;
    }

    return p.removeListener.apply(this, arguments);
};
