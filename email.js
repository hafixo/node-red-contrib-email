/**
 * Copyright 2013, 2015 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function(RED) {
    "use strict";
    var nodemailer = require("nodemailer");
    var Imap = require('imap');

    //console.log(nodemailer.Transport.transports.SMTP.wellKnownHosts);

    try {
        var globalkeys = RED.settings.email || require(process.env.NODE_RED_HOME+"/../emailkeys.js");
    } catch(err) {
    }

    function EmailNode(n) {
        RED.nodes.createNode(this,n);
        this.topic = n.topic;
        this.name = n.name;
        this.outserver = n.server;
        this.outport = n.port;
        var flag = false;
        if (this.credentials && this.credentials.hasOwnProperty("userid")) {
            this.userid = this.credentials.userid;
        } else {
            if (globalkeys) {
                this.userid = globalkeys.user;
                flag = true;
            } else {
                this.error(RED._("email.errors.nouserid"));
            }
        }
        if (this.credentials && this.credentials.hasOwnProperty("password")) {
            this.password = this.credentials.password;
        } else {
            if (globalkeys) {
                this.password = globalkeys.pass;
                flag = true;
            } else {
                this.error(RED._("email.errors.nopassword"));
            }
        }
        if (flag) {
            RED.nodes.addCredentials(n.id,{userid:this.userid, password:this.password, global:true});
        }
        var node = this;

        var smtpTransport = nodemailer.createTransport({
            host: node.outserver,
            port: node.outport,
            secure: node.secure,
            auth: {
                user: node.userid,
                pass: node.password
            }
        });

        this.on("input", function(msg) {
            if (msg.hasOwnProperty("payload")) {
                if (smtpTransport) {
                    node.status({fill:"blue",shape:"dot",text:"email.status.sending"});
                    if (msg.to && node.name && (msg.to !== node.name)) {
                        node.warn(RED._("node-red:common.errors.nooverride"));
                    }
                    var sendopts = { from: msg.from || node.userid };   // sender address
                    sendopts.to = node.name || msg.to; // comma separated list of addressees
                    sendopts.subject = msg.topic || msg.title || "Message from Node-RED"; // subject line
                    if (Buffer.isBuffer(msg.payload)) { // if it's a buffer in the payload then auto create an attachment instead
                        if (!msg.filename) {
                            var fe = "bin";
                            if ((msg.payload[0] === 0xFF)&&(msg.payload[1] === 0xD8)) { fe = "jpg"; }
                            if ((msg.payload[0] === 0x47)&&(msg.payload[1] === 0x49)) { fe = "gif"; } //46
                            if ((msg.payload[0] === 0x42)&&(msg.payload[1] === 0x4D)) { fe = "bmp"; }
                            if ((msg.payload[0] === 0x89)&&(msg.payload[1] === 0x50)) { fe = "png"; } //4E
                            msg.filename = "attachment."+fe;
                        }
                        sendopts.attachments = [ { content: msg.payload, filename:(msg.filename.replace(/^.*[\\\/]/, '') || "file.bin") } ];
                        if (msg.hasOwnProperty("headers") && msg.headers.hasOwnProperty("content-type")) {
                            sendopts.attachments[0].contentType = msg.headers["content-type"];
                        }
                        // Create some body text..
                        sendopts.text = RED._("email.default-message",{filename:(msg.filename.replace(/^.*[\\\/]/, '') || "file.bin"),description:(msg.hasOwnProperty("description") ? "\n\n"+msg.description : "")});
                    }
                    else {
                        var payload = RED.util.ensureString(msg.payload);
                        sendopts.text = payload; // plaintext body
                        if (/<[a-z][\s\S]*>/i.test(payload)) { sendopts.html = payload; } // html body
                        if (msg.attachments) { sendopts.attachments = msg.attachments; } // add attachments
                    }
                    smtpTransport.sendMail(sendopts, function(error, info) {
                        if (error) {
                            node.error(error,msg);
                            node.status({fill:"red",shape:"ring",text:"email.status.sendfail"});
                        } else {
                            node.log(RED._("email.status.messagesent",{response:info.response}));
                            node.status({});
                        }
                    });
                }
                else { node.warn(RED._("email.errors.nocredentials")); }
            }
            else { node.warn(RED._("email.errors.nopayload")); }
        });
    }
    RED.nodes.registerType("e-mail2",EmailNode,{
        credentials: {
            userid: {type:"text"},
            password: {type: "password"},
            global: { type:"boolean"}
        }
    });

    function EmailInNode(n) {
        RED.nodes.createNode(this,n);
        this.name = n.name;
        this.repeat = n.repeat * 1000 || 300000;
        this.inserver = n.server || (globalkeys && globalkeys.server) || "imap.gmail.com";
        this.inport = n.port || (globalkeys && globalkeys.port) || "993";
        this.box = n.box || "INBOX";
        var flag = false;

        if (this.credentials && this.credentials.hasOwnProperty("userid")) {
            this.userid = this.credentials.userid;
        } else {
            if (globalkeys) {
                this.userid = globalkeys.user;
                flag = true;
            } else {
                this.error(RED._("email.errors.nouserid"));
            }
        }
        if (this.credentials && this.credentials.hasOwnProperty("password")) {
            this.password = this.credentials.password;
        } else {
            if (globalkeys) {
                this.password = globalkeys.pass;
                flag = true;
            } else {
                this.error(RED._("email.errors.nopassword"));
            }
        }
        if (flag) {
            RED.nodes.addCredentials(n.id,{userid:this.userid, password:this.password, global:true});
        }

        var node = this;
        this.interval_id = null;
        var oldmail = {};

        var imap = new Imap({
            user: node.userid,
            password: node.password,
            host: node.inserver,
            port: node.inport,
            tls: true,
            tlsOptions: { rejectUnauthorized: false },
            connTimeout: node.repeat,
            authTimeout: node.repeat
        });

        if (!isNaN(this.repeat) && this.repeat > 0) {
            this.interval_id = setInterval( function() {
                node.emit("input",{});
            }, this.repeat );
        }

        this.on("input", function(msg) {
            imap.once('ready', function() {
                node.status({fill:"blue",shape:"dot",text:"email.status.fetching"});
                var pay = {};
                imap.openBox(node.box, false, function(err, box) {
                    if (err) {
                        node.status({fill:"red",shape:"ring",text:"email.status.foldererror"});
                        node.error(RED._("email.errors.fetchfail",{folder:node.box}),err);
                    }
                    else {
                        if (box.messages.total > 0) {
                            //var f = imap.seq.fetch(box.messages.total + ':*', { markSeen:true, bodies: ['HEADER.FIELDS (FROM SUBJECT DATE TO CC BCC)','TEXT'] });
                            var f = imap.seq.fetch(box.messages.total + ':*', { markSeen:true, bodies: ['HEADER','TEXT'] });
                            f.on('message', function(msg, seqno) {
                                node.log(RED._("email.status.message",{number:seqno}));
                                var prefix = '(#' + seqno + ') ';
                                msg.on('body', function(stream, info) {
                                    var buffer = '';
                                    stream.on('data', function(chunk) {
                                        buffer += chunk.toString('utf8');
                                    });
                                    stream.on('end', function() {
                                        if (info.which !== 'TEXT') {
                                            var head = Imap.parseHeader(buffer);
                                            if (head.hasOwnProperty("from")) { pay.from = head.from[0]; }
                                            if (head.hasOwnProperty("subject")) { pay.topic = head.subject[0]; }
                                            if (head.hasOwnProperty("date")) { pay.date = head.date[0]; }
                                            pay.header = head;
                                        } else {
                                            var parts = buffer.split("Content-Type");
                                            for (var p = 0; p < parts.length; p++) {
                                                if (parts[p].indexOf("text/plain") >= 0) {
                                                    pay.payload = parts[p].split("\n").slice(1,-2).join("\n").trim();
                                                }
                                                else if (parts[p].indexOf("text/html") >= 0) {
                                                    pay.html = parts[p].split("\n").slice(1,-2).join("\n").trim();
                                                } else {
                                                    pay.payload = parts[0];
                                                }
                                            }
                                            //pay.body = buffer;
                                        }
                                    });
                                });
                                msg.on('end', function() {
                                    //node.log('finished: '+prefix);
                                });
                            });
                            f.on('error', function(err) {
                                node.warn(RED._("email.errors.messageerror",{error:err}));
                                node.status({fill:"red",shape:"ring",text:"email.status.messageerror"});
                            });
                            f.on('end', function() {
                                delete(pay._msgid);
                                if (JSON.stringify(pay) !== oldmail) {
                                    oldmail = JSON.stringify(pay);
                                    node.send(pay);
                                    node.log(RED._("email.status.newemail",{topic:pay.topic}));
                                }
                                else { node.log(RED._("email.status.duplicate",{topic:pay.topic})); }
                                //node.status({fill:"green",shape:"dot",text:"node-red:common.status.ok"});
                                node.status({});
                            });
                        }
                        else {
                            node.log(RED._("email.status.inboxzero"));
                            //node.status({fill:"green",shape:"dot",text:"node-red:common.status.ok"});
                            node.status({});
                        }
                    }
                    imap.end();
                });
            });
            node.status({fill:"grey",shape:"dot",text:"node-red:common.status.connecting"});
            imap.connect();
        });

        imap.on('error', function(err) {
            node.log(err);
            node.status({fill:"red",shape:"ring",text:"email.status.connecterror"});
        });

        this.on("close", function() {
            if (this.interval_id != null) {
                clearInterval(this.interval_id);
            }
            if (imap) { imap.destroy(); }
        });

        node.emit("input",{});
    }
    RED.nodes.registerType("e-mail2 in",EmailInNode,{
        credentials: {
            userid: {type:"text"},
            password: {type: "password"},
            global: { type:"boolean"}
        }
    });
};
