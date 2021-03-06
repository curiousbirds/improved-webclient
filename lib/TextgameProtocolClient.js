/**
 * This library is used to communicate with a textgame-gateway v1 server
 * via a websocket.  Clients should set the public attributes to
 * appropriate methods (as desired) before connecting.
 */
function TextgameProtocolClient() {
    /** PUBLIC ATTRIBUTES **/

    // User function to call when a line of text has been received.  The
    // first (and only) parameter will be the text.
    //
    this.onReceivedTextLine = null;

    // User function to call when the connection has been (re)established
    // No parameters will be provided.
    //
    this.onConnectionEstablished = null;

    // User function to call when connection has been (temporarily) lost
    // No parameters will be provided.
    //
    this.onLostConnection = null;

    // User function to call when permanently disconnected, whether
    // due to an error or disconnect() being called by the user.
    // No parameters will be provided.
    // If an error condition, this will be called first, followed by
    // onError.
    //
    this.onDisconnection = null;

    // User function to call when an error has occurred.  The connection
    // state will revert to disconnected.
    // An argument with the error in plaintext will be provided.
    //
    this.onError = null;

    /** PRIVATE ATTRIBUTES **/

    // Enumeration of all states of this instance
    //
    var StateEnum = {
        // Not connected, not requested to connect
        DISCONNECTED : 1,
        // Initial connection in progress.
        CONNECTING : 2,
        // Connected, authenticated.  Data is flowing.
        CONNECTED : 3,
        // Lost connection, about to auto reconnect
        CONNECTION_LOST : 4,
        // Connected first time, registering to get auth code
        REGISTERING : 5,
        // Reconnection in progress
        RECONNECTING : 6,
        // Reauthentication after reconnection in progress
        REAUTHENTICATING : 7
    };

    // Current state of instance
    //
    var currentState = StateEnum.DISCONNECTED;

    // Queue of lines of text.
    //
    var outgoingLines = [];

    // Queue of outgoing control messages; these have priority.
    //
    var outgoingControls = [];

    // The outgoing sequence ID for the line we sent out.
    //
    var outgoingSequence = 0;

    // The incoming sequence ID for lines we are receiving.
    //
    var incomingSequence = ' ';

    // The size (in lines) of the incoming window (data from server)
    //
    var incomingWindow = 0;

    // The size (in lines) of the outcoming window (data from us to server),
    //
    var outgoingWindow = 8;

    // The index of the next outgoing item.  Note that this cannot be > the
    // outgoing window.  -1 if nothing is in outgoingLines.
    //
    var outgoingIndex = -1;

    // The registration ID we got during the initial connect
    //
    var registrationId = null;

    // Reference to the active websocket
    //
    var socket = null;

    // The URL we're connecting to
    //
    var socketUrl = "";

    // If a timer is currently running, its ID will be here.
    //
    var activeTimer = -1;


    /** PUBLIC METHODS **/


    /**
     * @public
     * Connects the websocket to the provided URL, if not already connected.
     * The connection will complete in the background.
     * @param {string} url The websocket URL to connect to.
     * @return {boolean} True if connection has successfully started or
     * already connected.
     */
    this.connect = function(url) {
        if (currentState === StateEnum.DISCONNECTED) {
            socketUrl = url;

            if (this.establishConnection()) {
                currentState = StateEnum.CONNECTING;
            } else {
                return false;
            }
        }

        return true;
    };

    /**
     * @public
     * Sends a line of text (string) to the server.
     * @param {string} lineToSend The line of text to send to the server.
     */
    this.sendLine = function(lineToSend) {
        if (typeof lineToSend === "string") {
            outgoingLines.push({line: lineToSend, seq : outgoingSequence});
            if (outgoingIndex === -1) {
                // First entry
                outgoingIndex = 0;
            }

            incrementSequence();
            sendQueueContents();
        }
    };

    /**
     * @public
     * Disconnects from the server.  All queued data is lost.
     */
    this.disconnect = function() {
        cancelTimer();

        if (currentState !== StateEnum.DISCONNECTED) {
            if (currentState === StateEnum.CONNECTED) {
                outgoingControls.push("DI");
                sendQueueContents();
            }

            currentState = StateEnum.DISCONNECTED;

            if (socket !== null) {
                try {
                    socket.onclose = null;
                    socket.onerror = null;
                    socket.onmessage = null;
                    socket.onopen = null;
                    socket.close();
                } catch (e) {
                    // Do nothing, just ignore.
                }
                socket = null;
            }

            this.callDisconnection();
        }

        outgoingLines = [];
        outgoingControls = [];
        outgoingIndex = -1;

        incomingWindow = 0;

        registrationId = null;
        incomingSequence = ' ';
        outgoingSequence = 0;
    };

    /** PRIVATE METHODS **/


    /**
     * @private
     * Periodically tries to reconnect when called by a timer.
     */
    this.timerReconnect = function() {
        if (this.establishConnection()) {
            currentState = StateEnum.RECONNECTING;
        } else {
            this.disconnect();
            this.callOnError("Unable to initiate reconnect.");
        }
    };

    /**
     * @private
     * Handles, after the timer delay, any registration or authentication
     * needed to fully establish the connection.
     */
    this.timerConnectionOpen = function() {
        if (currentState === StateEnum.CONNECTING) {
            // First connection.  Register and get our ID.
            //
            currentState = StateEnum.REGISTERING;
            socket.send("CO" + outgoingWindow);
        } else if (currentState === StateEnum.RECONNECTING) {
            // Reconnection.  Re-register.  Send the last successfully
            // received incoming sequence ID so it doesn't get resent.
            //
            currentState = StateEnum.REAUTHENTICATING;
            socket.send("RE" + incomingSequence + registrationId);
        }
    };

    /**
     * @private
     * If nothing is currently being sent, sends a ping message out
     * to make sure the connection stays alive.
     */
    this.timerPing = function() {
        if (socket.bufferedAmount === 0) {
            outgoingControls.push("PI");
            sendQueueContents();
        }
    };

    /**
     * @private
     * Handles callback from WebSocket when connection is abruptly closed.
     */
    this.processWebsocketClose = function() {
        switch (currentState) {
            case StateEnum.CONNECTING:
            case StateEnum.REGISTERING:
            {
                // Failed initial connect.  Error out.
                //
                this.disconnect();
                this.callOnError("Unable to establish initial connection.");
                break;
            }

            case StateEnum.CONNECTED:
            case StateEnum.RECONNECTING:
            case StateEnum.REAUTHENTICATING:
            {
                var wasReconnecting = (currentState === StateEnum.RECONNECTING) ||
                    (currentState === StateEnum.REAUTHENTICATING);

                // Lost connection after initial connection established
                // and registered.  Try and reconnect.
                //
                cancelTimer();

                currentState = StateEnum.CONNECTION_LOST;

                if (! wasReconnecting) {
                    this.callLostConnection();
                }

                outgoingControls = [];

                socket = null;

                activeTimer = setTimeout(function(client) {
                    return function(){
                        client.timerReconnect();
                    }
                }(this), 3000);

                break;
            }
        }
    };

    /**
     * @private
     * Handles callback from WebSocket when connection has been (re)established.
     */
    this.processWebsocketConnected = function() {
        cancelTimer();

        // Delay slightly before sending/receiving data due to apparent
        // race conditions in some browsers.  Maybe this isn't really needed.
        //
        activeTimer = setTimeout(function(client) {
            return function(){
                client.timerConnectionOpen();
            }
        }(this), 500);
    };

    /**
     * @private
     * Processes the raw text from the websocket.
     * @param rawLine {String} The raw data.
     */
    this.processWebsocketData = function(rawLine) {
        var success = (rawLine.length >= 2);

        if (success) {
            switch (rawLine.substr(0, 2))  {
                case "AK":
                {
                    var ackSeq = rawLine.substr(2, 1);

                    if ((outgoingIndex > 0) && (outgoingLines.length > 0) &&
                        (ackSeq == outgoingLines[0].seq)) {
                        // Got an acknowledge for the next line, so pop it off
                        // and send more.
                        outgoingLines.shift();
                        --outgoingIndex;

                        if (outgoingLines.length === 0) {
                            // Nothing left to send.
                            outgoingIndex = -1;
                        }
                    } else {
                        success = false;
                    }

                    break;
                }

                case "DI":
                {
                    // THe other side is going to disconnect, so let's close
                    // up now.
                    this.disconnect();
                    this.callOnError("Other side closed connection");
                    break;
                }

                case "ID":
                {
                    // Initial registration succeeded.
                    //
                    var idInfo = rawLine.substr(2).split(",");

                    if (idInfo.length !== 2) {
                        success = false;
                    } else if (idInfo[1].length === 0) {
                        success = false;
                    } else {
                        incomingWindow = parseInt(idInfo[0]);
                        registrationId = idInfo[1];
                        currentState = StateEnum.CONNECTED;
                        cancelTimer();
                        activeTimer = setInterval(function(client) {
                            return function(){
                                client.timerPing();
                            }
                        }(this), 30000);

                        this.callConnectionEstablished();
                    }

                    break;
                }

                case "LI":
                {
                    // Got a line of data
                    //
                    var seq = rawLine.substr(2,1);
                    var data = rawLine.substr(3);

                    if (seq.length !== 1) {
                        success = false;
                    } else {
                        // Even if we've seen the sequence before,
                        // send out the ACK so we won't see that line again.
                        // Duplicates should never occur but ignore them if
                        // they do.
                        //
                        outgoingControls.push("AK" + seq);

                        if (incomingSequence !== seq) {
                            // It's a line we haven't seen before.  Accept it.
                            //
                            incomingSequence = seq;

                            // Make any symbols special to HTML pass through
                            //
                            // (Disabled.  Can't have this when doing ANY kind of text processing
                            // on information from the TextgameProtocolClient.  Also, missing it seems
                            // to make absolutely no difference.)
                            //data = data.replace(/&/g, "&amp");
                            //data = data.replace(/</g, "&lt");
                            //data = data.replace(/>/g, "&gt");

                            // Make sure there are no newlines on the line.
                            data = data.replace("\n", "");

                            this.callReceivedTextLine(data);
                        }
                    }

                    break;
                }

                case "AC":
                {
                    // Reconnect was accepted
                    //
                    var lastSeq = rawLine.substr(2,1);

                    // Delete any lines at and before the last sequence
                    // received, up until the outgoingIndex.
                    //
                    if (outgoingIndex !== -1) {
                        var eraseCount = -1;

                        for (var index = 0; index < outgoingIndex; ++index) {
                            if (outgoingLines[index].seq === lastSeq) {
                                // Found our erasure point
                                eraseCount = index + 1;
                                break;
                            }
                        }

                        if (eraseCount !== -1) {
                            outgoingLines.splice(0, eraseCount);
                        }

                        if (outgoingLines.length > 0) {
                            outgoingIndex = 0;
                        } else {
                            // Empty after removing what was received by the
                            // server.
                            outgoingIndex = -1;
                        }
                    }

                    this.updateReconnectState();
                    break;
                }
            }
        }

        if (success) {
            sendQueueContents();
        } else {
            this.disconnect();
            this.callOnError("Invalid data received");
        }
    };

    /**
     * @private
     * Used to determine if the received data indicates a successful
     * reconnection.  If we are not reconnecting, this does nothing.
     */
    this.updateReconnectState = function() {
        if (currentState === StateEnum.REAUTHENTICATING) {
            // Our reregistration succeeded,
            //
            currentState = StateEnum.CONNECTED;
            cancelTimer();
            activeTimer = setInterval(function(client) {
                return function(){
                    client.timerPing();
                }
            }(this), 30000);

            this.callConnectionEstablished();
        }
    }

    /**
     * @private
     * Creates a websocket, adds the required listeners, then initiates a
     * connection.
     * @return {boolean} True if success, false if error.
     */
    this.establishConnection = function() {
        try {
            socket = new WebSocket(socketUrl, "textgame-gateway-v1");

            socket.onmessage = function(client) {
                return function(socketData){
                    client.processWebsocketData(socketData.data);
                };
            }(this);

            socket.onopen = function(client) {
                return function(){
                    client.processWebsocketConnected();
                };
            }(this);

            /** Doesn't seem to be useful
            socket.onerror = function(client) {
                return function(error){
                    lastError = "" + error;
                };
            }(this);
             */

            socket.onclose = function(client) {
                return function (){
                    client.processWebsocketClose();
                };
            }(this);
        } catch (e) {
            socket = null;
            return false;
        }

        return true;
    };

    /**
     * @private
     * Calls onError with the error string, if onError is set.
     * @param {string} reason A user-readable string concerning the error.
     */
    this.callOnError = function(reason) {
        if ((this.onError !== null) && (typeof(this.onError) === "function")) {
            this.onError(reason);
        }
    };

    /**
     * @private
     * Calls onReceivedTextLine, if it is set.
     */
    this.callReceivedTextLine = function(data) {
        if ((this.onReceivedTextLine !== null) &&
            (typeof(this.onReceivedTextLine) === "function")) {
            this.onReceivedTextLine(data);
        }
    };

    /**
     * @private
     * Calls onLostConnection, if it is set.
     */
    this.callConnectionEstablished = function() {
        if ((this.onConnectionEstablished !== null) &&
            (typeof(this.onConnectionEstablished) === "function")) {
            this.onConnectionEstablished();
        }
    };

    /**
     * @private
     * Calls onLostConnection, if it is set.
     */
    this.callLostConnection = function() {
        if ((this.onLostConnection !== null) &&
            (typeof(this.onLostConnection) === "function")) {
            this.onLostConnection();
        }
    };

    /**
     * @private
     * Calls onDisconnection, if it is set.
     */
    this.callDisconnection = function() {
        if ((this.onDisconnection !== null) &&
            (typeof(this.onDisconnection) === "function")) {
            this.onDisconnection();
        }
    };

    /**
     * @private
     * If connected and not already sending, send the next line from the
     * text or control queues out to the websocket.
     */
    var sendQueueContents = function() {
        if (currentState === StateEnum.CONNECTED) {
            var keepSending = true;

            // Send any control messages first.
            // If they get lost, it's OK, because they will be regenerated
            // as needed.
            //
            while (keepSending && (outgoingControls.length > 0)) {
                try {
                    socket.send(outgoingControls.shift());
                } catch (e) {
                    keepSending = false;
                    // Disconnect cleanup is handled elsewhere via websocket
                    // callback.
                }
            }

            // Still connected, so see if any more lines can go out.
            // Send up until the window edge.
            //
            keepSending = keepSending && (outgoingIndex !== -1) &&
                (outgoingIndex < outgoingWindow);

            while (keepSending && (outgoingIndex < outgoingWindow) &&
                    (outgoingIndex < outgoingLines.length)) {
                var outgoingItem = outgoingLines[outgoingIndex];
                var stringToSend = "LI" + outgoingItem.seq + outgoingItem.line;

                try {
                    socket.send(stringToSend);
                    ++outgoingIndex;
                } catch (e) {
                    keepSending = false;
                    // Disconnect cleanup is handled elsewhere via websocket
                    // callback.
                }
            }
        }
    };

    /**
     * @private
     * Increments outgoingSequence.
     */
    var incrementSequence = function() {
        ++outgoingSequence;

        if (outgoingSequence === 10) {
            outgoingSequence = 0;
        }
    };

    /**
     * @private
     * If a timer is active, cancels it.
     */
    var cancelTimer = function() {
        if (activeTimer !== -1) {
            clearTimeout(activeTimer);
            activeTimer = -1;
        }
    };
};
