/*jslint node: true */
'use strict';

var util = require('util');
var parser = require('./parser');
var EventEmitter = require('events').EventEmitter;

// utility function to support different event listener models: aka node, dom, angular
function addEventListener(source, event, listener) {
    if (typeof source === 'object' ) {
        if(typeof source.on === 'function') {
            source.on(event, listener);
            return true;
        } else if(typeof source.addEventListener === 'function') { // DOM
            source.addEventListener(event, listener);
            return true;
        }
    }
    return false;
}

function removeEventListener(source, event, listener) {
    if (typeof source === 'object' ) {
        if(typeof source.removeListener === 'function') {
            source.removeListener(event, listener);
            return true;
        } else if(typeof source.removeEventListener === 'function') { // DOM
            source.removeEventListener(event, listener);
            return true;
        }
    }
    return false;
}

/**
 * @typedef stateDefinition
 * @property type {string} 'begin': initial state on flow start, 'state': normal state (default), 'end': flow terminates when this state 
 * @property action {action} executed when the state becomes active, defined a function, action name to use a registered action or subflow object flow definition.
 * @property initialize {function} is called when the flow starts.
 * @property destroy  {function} is called when the flow exits.
 * @property on {object} key is state completion event value is the next state to goto. 'objectName.eventName' is also supported, aka if this.get('objectName') emits eventName then goto the next state .
 */

 /**
 * @typedef flowDefinition {object}
 * @property *stateName* {stateDefinition} every state has a state name and a state definition.
 */

/**
 * Instance assigned to each state in a flow and bound to the action's this variable.
 * @constructor State
 * @param {stateDefinition} config subflow definition which might contain additional properties.
 * @param {string} name state name.
 * @param {StateFlow} parent flow.
 * @property {boolean} active is true when the state is the current state (initial false ofcourse).
 * @property {StateFlow|undefined} parent only set on subflows and regular states.
 * @property {stateDefinition} config state definition
 *
 */
function State(config, name, parent) {
    this.data = {};

    /**
     * @typedef {object} StateFlow~stateDefinition
     * @property {string|action|flowDefinition} action - this action is executed when the state becomes active
     * @property {object} - on event <key> goto state <value>, the event source is the instance state or an object (separated by a dot: "source.event" : "nextstate". 
     */
    this.config = config;
    this.name = name;
    this.parent = parent;

    // an array of objects with follwing properties: target, event, listener
    this.listeners = [];

    this.flowActiveListeners = [];

    this.on('exit', function () {
        this.listeners.forEach(function (config) {
            removeEventListener(config.source, config.event, config.listener);
        });
        this.listeners = [];
        this.cancelTimeout();
    });


    this.timeout = 0;
    this.listeners = [];

}

util.inherits(State, EventEmitter);
/**
 * @method
 * Get an object value from the current state or it's parents.
 * @param name {string} the object name
 */
State.prototype._removeActiveFlowListeners = function() {
    this.flowActiveListeners.forEach( function(config) {
        removeEventListener(config.source, config.event, config.listener);
    });
    this.flowActiveListeners = [];
};

State.prototype.get = function (name) {
    var value;
    if (this.data[name]) {
        value = this.data[name];
    } else if (this.parent) {
        value = this.parent.get(name);
    }
    /* was not so a good idea, obviously since passing around functions is kind of normal
    if (typeof value === 'function') {
        return value();
    }
    */
    return value;
};

/**
 * Set a property
 * @param name {string} 
 * @param obj {object|function} object or getter function executed on {@link State#get}
 */
State.prototype.set = function (name, obj) {
    this.data[name] = obj;
};

State.prototype.createListenerConfig = function(objectOrName, event, listener) {

    var self = this, listenerConfig = {
        source: typeof objectOrName === 'object' ? objectOrName : this.get(objectOrName),
        event: event,
        listener: listener
    };

    if(listener === undefined) { // listener is undefined so original event is complete event
        listenerConfig.listener = function () {
            self.stateComplete(event, arguments);
        };
    } else if (typeof listener === 'string') { // listener is a string complete event
        listenerConfig.listener = function () {
            var args = [listener];
            args.push.apply(args, arguments);
            try {
                self.emit.apply(self, args);
            } catch(e) {
                self.handleError(e);
            }
        };
    } else {
        listenerConfig.listener = function () {
            try {
                    listener.apply(self, arguments); // call the listener with stateobject as "this"
            } catch(e) {
                self.handleError(e);
            }
        };
    }
    return listenerConfig;
};
 /**
  * Listen to an event on the source (name or object) while the state is active, removed on exit.
  *
  * @param objectOrName {object|string} the service name (string) which was registered with set or event emitter instance (object), 
  * @param event {string} the event to listen on
  * @param listener {callback|string} event listener function or state completion event 
  */
State.prototype.onStateActive = function (objectOrName, event, listener) {
    var listenerConfig = this.createListenerConfig(objectOrName,event, listener);

    if(addEventListener(listenerConfig.source, listenerConfig.event, listenerConfig.listener)) {
        this.listeners.push(listenerConfig); // listeners must be renamed too stateActiveListeners.
    }

};

State.prototype.listenTo = function(objectOrName, event, listener) {
    console.error("listenTo is deprecated please use 'onStateActive'");
    this.onStateActive(objectOrName, event, listener);
};

/**
 * Listen to an event on the source (name or object) while the flow is running, removed when the flow exits.
 * @param objectOrName {object|string} object: the source object to listen on, string: the source name retrieved by state.get(name)
 * @param event {string} the event to listen on
 * @param listener {string|function) string: send state completion event, function: event listener function.
 */
State.prototype.onFlowActive = function(objectOrName, event, listener) {
    var list, listenerConfig, key = {source: objectOrName, event:event, listener: listener};

    list = this.flowActiveListeners.filter(function (config) {
        return config.key.source === key.source && config.key.event === key.event && config.key.listener === key.listener;
    });

    if(list.length === 0) {
        listenerConfig = this.createListenerConfig(objectOrName, event, listener);
        listenerConfig.key = key;

       if(addEventListener(listenerConfig.source, listenerConfig.event, listenerConfig.listener)) {
           this.flowActiveListeners.push(listenerConfig);
       }

    } else if(list.length > 1) {
        throw new Error('More than one of the same onFlowActive listener registered!');
    }

};

/**
 * Cancel the previous installed timeout, always executed when state exits.
 * Can be used within a state action.
 */
State.prototype.cancelTimeout = function () {
    if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
    }
    delete this.lastTimeoutAction;
    delete this.lastTimeoutTime;
};

/**
 * Install a state timeout handler fired when the state is active, cancelled on state exit.
 * @param timeout {number|undefined} timeout in milliseconds, undefined: reuse the last timeout after the last cancelTimeout()
 * @param handler {callback|string|undefined} callback: timeout function, string: emit state event on timeout, undefined: reuse the last handler after cancelTimeout()
 */
State.prototype.installTimeout = function (timeout, handler) {
    var cb, self = this, effectiveTimeout = timeout || this.lastTimeoutTime;
    if (typeof handler === 'function') {
        cb = function () {
            try {
                handler.call(self);
            } catch(e) {
                self.handleError(e);
            }
        };
    } else if (typeof handler === 'string') {
        cb = function () {
            self.stateComplete(handler);
        };
    } else if (this.lastTimeoutAction) { 
        // install timeout without handler will reinstall the last after cancelTimeout() if there was such one.
        cb = this.lastTimeoutAction;
    } else {
        cb = function () {
            self.stateComplete('timeout');
        };
    }
    if( effectiveTimeout === undefined ) {
        throw new Error('Could not determ timeout value!');
    }

    this.cancelTimeout();

    this.timeoutHandle = setTimeout(cb, effectiveTimeout );
    this.lastTimeoutAction = cb;
    this.lastTimeoutTime = effectiveTimeout;
};

State.prototype.handleError = function (error) {
     if(EventEmitter.listenerCount(this,'error') > 0) {
        try {
            this.emit('error', error);
        } catch(e) {
            this.stateComplete('error', e);
        }
    } else {
        this.stateComplete('error', error);
    }

};

/**
 * StateFlow is an async event state machine, using js object notation.<br/>
 * Every property is a state, the key is state name and the value is the state config:<br/>
 *  action: function, register action, or subflow definition.<br/>
 *  on: on key source event (or sourceObjectName.event) goto value: the next state<br/>
 *  type: 'begin': the initial state of the flow, 'end': the state that terminates the flow after executing action.
 *
 * <pre>
 * Usage:
 * var flow = new StateFlow({
 *      beginState: {
 *          type: 'begin',
 *          action: function (complete) {
 *              complete('anEvent');
 *          },
 *          on: {
 *              anEvent:'nextState'
 *          }
 *      },
 *      nextState: {
 *          type: 'end',
 *          action: function (complete) {
 *              complete('done'); 
 *          } 
 *      }
 * });
 * flow.start(function (event) {
 *     if(event !== 'done') throw new Error('event must be done, as in nextState');
 * });
 * </pre>
 * @exports stateflow.StateFlow
 * @extends State
 * @constructor
 * @param config {flowDefinition} flow definition
 * @property currentState {string}
 * @property parent {StateFlow}
 */
function StateFlow(config, name, parent) {
    /**
     * @typedef flowDefinition {object} where the key is the state and the value a {@link stateDefinition}
     */
    State.call(this, config, name, parent);
    this.actions = {};
    this.actionsInitializers = {};
    this.actionsDestructors = {};

    this.states = {};
    this.on('newListener', function (event, listener) {
        // call a state listener when the state is already active
        if (event === 'state:' + this.currentState) {
            listener.call(this, this.currentState);
        }
    });

    this.on('flow:entry', function() {
        Object.keys(config).forEach(function (state) {
            this.initializeState(state);
        }, this);
    });

    this.on('flow:exit', function() {
        Object.keys(config).forEach(function (state) {
            this.destroyState(state);
        }, this);
        this.states = {};
    });

    this.serviceFromEventSeparator = '.';
}
util.inherits(StateFlow, State);

/**
 * Register a named action function
 * @param name {string} action name
 * @param action {function|string|object} called when the state becomes active
 * @param initializer {function} flow start callback
 * @param destructor {function} flow exit callback
 * @memberof StateFlow {
 */
StateFlow.prototype.registerAction = function (name, action, initializer, destructor) {
    this.actions[name] = action;
    if(typeof initializer ==='function') {
        this.actionsInitializers[name] = initializer;
    }
    if(typeof destructor === 'function') {
        this.actionsDestructors[name] = destructor;
    }
};

/**
 * Get registered action from the current flow, travel the parent chain until the named action is found (action's registered in the parent flow are also available in the subflow).
 * @returns literal registered action {string|object|function}
 * @private
 */
StateFlow.prototype.getRegisteredAction = function (name) {
    if (this.actions[name]) {
        return this.actions[name];
    }
    if (this.parent) {
        return this.parent.getRegisteredAction(name);
    }
};

/**
 * @param state {string} state name of a subflow
 * @returns {flowDefinition} flow definition of a subflow.
 * @private
 */
StateFlow.prototype.getSubFlowConfig = function (state) {
    var def = this.config[state], action;
    if (typeof def.action === 'object') {
        action = def.action;
    } else if (typeof def.action === 'string') {
        action = this.getRegisteredAction(def.action);
        if (typeof action !== 'object') {
            throw new Error(def + ' is not a subflow!');
        }
    } else {
        throw new Error(def.action + ' is not a subflow!');
    }

    return action;
};

/**
 * Check state action is a subflow or references a subflow.
 * @returns {Boolean}
 * @private
 */
StateFlow.prototype.isSubFlowState = function (state) {
    var def = this.config[state];
    if (typeof def.action === 'object') {
        return true;
    }
    return (typeof def.action === 'string' && typeof this.getRegisteredAction(def.action) === 'object');
};

StateFlow.prototype.initializeState = function(state) {
    var stateObject = this.createStateObject(state);

    if(typeof this.config[state].initialize === 'function') {
        this.config[state].initialize.call(stateObject);
    } else if(typeof state.action ==='string') {
        if( this.actionsInitializers[state.action]) {
            this.actionsInitializers[state.action].call(stateObject);
        }
    }
};

StateFlow.prototype.destroyState = function(state) {
    var stateObject = this.getStateObject(state);
    if(!stateObject) throw new Error('destroyState, stateobject is undefined!');
    stateObject._removeActiveFlowListeners(); // avoid extra event listener

    if(typeof this.config[state].destroy === 'function') {
        this.config[state].destroy.call(stateObject);
    }  else if(typeof state.action ==='string') {
        if( this.actionsDestructors[state.action]) {
            this.actionsDestructors[state.action].call(stateObject);
        }
    }

    this.states[state] = undefined;
};

/**
 * Get state action function
 * @param state state name to get the action from.
 * @returns {action}
 * @private
 */
StateFlow.prototype.getAction = function (state) {
    var def = this.config[state], action;

    if (typeof def.action === 'function') {
        return def.action;
    }
    if (typeof def.action === 'string') {
        action = this.getRegisteredAction(def.action);
        if (typeof action === 'object') {
            return this.createSubFlowAction();
        }
        return action;
    }
    if (typeof def.action === 'object') {
        return this.createSubFlowAction();
    }
    // this makes action optional!
    return undefined;
};



/**
 * @returns {action} subflow state action
 * @private
 */
StateFlow.prototype.createSubFlowAction = function () {
    return function (complete) {
        // action is executed State object assigned to this in this case StateFlow
        // TODO: forward error
        this.start(function (event) {
            var args = [event];
            args.push.apply(args, arguments);
            complete.apply(undefined, args);
        }, true);
    };
};


/**
 * Start the flow with the state of type 'begin' 
 * @param complete {completion} callback to be called when the end state has been reached.
 */
StateFlow.prototype.start = function (complete) {
    var self = this, states = this.findStatesByType('begin');

    if (states.length === 0) {
        throw new Error('No begin state found!');
    }
    if (states.length > 1) {
        throw new Error('Too many begin states found!');
    }
    this.emit('flow:entry'); // states just emit entry and exit maybe a flow should also (but only if it is a root flow).

    this.stateComplete = function(event) {
        try {
            if (typeof complete === 'function') {
                try {
                    complete.apply(self, arguments); // if it throw an exception should it kill our flow?
                } catch(e) {
                    // self.emit('error', e);
                    throw e;
                }
            }
        } finally {
            self.emit('flow:exit', event); // let give the flow callback a change to peek into the flow before getting destroyed!
        }
    };

    this.go(states[0], this.stateComplete);
};

/**
 * Find state by type
 * @param type {string} type to look for
 * @private
 */
StateFlow.prototype.findStatesByType = function (type) {
    return Object.keys(this.config).filter(function (stateName) {
        if (this[stateName].type === type || (type === 'state' && this[stateName].type === undefined)) {
            return true;
        }
    }, this.config);
};

/**
 * Set the flow in a specific state, this function is still considered internal because abruptly goes to the target state.
 * @param state {string} target state
 * @param complete {completion} the callback to be called when a state of type 'end' is reached, aka when the "flow-state" has been ended.
 * @property {string} currentState is set to the given state.
 * @private
 */
StateFlow.prototype.go = function (state, complete, event, args) {
    var stateDefinition = this.config[state], stateObj, action, oldState;

    if (stateDefinition === undefined) {
        var error = new Error("No state defination found for state '" + state + "'");
        error.code = 'stateNotFound';
        throw error;
    }

    stateObj = this.getStateObject(state);
     /**
      * State activation action, can be defined as function, by name (string) or by subflow definition (object).<br/>
      * If it was defined by name in the state definition then the must be been registered previously with registerAction().<br/>
      * If defined by flow definition then start and end of the flow will be mapped to the state.
      *
      * @callback action
      * @param completion {completion} state completion callback
      * @this {State}
      */
    action = this.getAction(state);

    stateObj.active = true;
    oldState = this.currentState;
    this.currentState = state;
    stateObj.stateComplete = this.createStateHandler(state, stateObj, complete);
    this.forwardEvents(stateObj, stateDefinition.on);
    /** 
     * State entry event fired just before a state action is called
     * @event module:stateflow.event:entry
     */
    stateObj.emit('entry', oldState ? this.getStateObject(oldState) : this , event, args);

    /**
     * Event fired when a specific stateName state has been reached, if new listener is added with an state:stateName which is already
     * current then the event will also be fired (stateName must must be replaced with an actual state).
     * @event state:stateName
     */
    this.emit('state:' + state, stateObj);

    try {
       if(action !== undefined) {
           var actionArgs = [stateObj.stateComplete];
           if(Array.isArray(stateDefinition.actionArgumentNames)) {
               stateDefinition.actionArgumentNames.forEach(function(name) {
                   actionArgs.push(stateObj.get(name));
               });
           }
           action.apply(stateObj, actionArgs);
       } else  {
           stateObj.stateComplete();
       }
    } catch(e) {
        stateObj.handleError(e,true);
    }

    /**
     * Emitted for every state change,
     * @param state {string} new state
     * @param oldState {string} previous state
     * @event stateChanged
     */
    this.emit('stateChanged', state, oldState, stateObj);

};

StateFlow.prototype.forwardEvents = function (stateObject, on, complete) {
    var forwardEvents = [];
    if (typeof on === 'object') {
        forwardEvents = Object.keys(on);
    }

    forwardEvents.forEach(function (key) {
        var serviceAndEvent;

        if( key.indexOf(this.serviceFromEventSeparator) !== -1) {
            serviceAndEvent = key.split(this.serviceFromEventSeparator);
        } else {
            serviceAndEvent = [stateObject, key];
        }

        stateObject.onStateActive(serviceAndEvent[0], serviceAndEvent[1], function (event) {
            //noinspection JSPotentiallyInvalidUsageOfThis
            this.stateComplete(key); // when the service.event appears, emit it agian as service.event event!
        });
    }, this);
/*
    if ( EventEmitter.listenerCount(stateObject, 'error') === 0 && stateObject.parent ) {
        // Forward errors to the parent
        // TODO: TEST THIS, NOTE COULD ALSO DOMAIN FOR THIS
        // NOTE: this will only catch error while the state is active, not if some delayed callback of a finished state comes back with an error
        stateObject.onStateActive(stateObject, 'error', function (e) {
            stateObject.stateComplete('error', e);
        });
    }
*/

};

/**
 * Create a completion function action parameter callback, the callback moves the flow to the next state when a on event matches.
 * @param state {string} the state where callback is created for
 * @param stateObj {object} 
 * @param flowCompleted {completion} end of flow callback.
 * @return complete {completion}
 * @private
 */
StateFlow.prototype.createStateHandler = function (state, stateObj, flowCompleted) {
    var stateDefinition = this.config[state], self = this, completed = false, stateCompletion;

    if (stateDefinition === undefined) {
        throw new Error("No state definition found for state '" + state + "'");
    }

    /**
     * State completion callback  available as first argument of {@link action} or as stateComplete property of {@link State}.
     * @name completion
     * @callback completion
     * @param event {string} completion event
     */
    stateCompletion = function (event, error) {
        var targetState, exitFunction, hasOn = typeof stateDefinition.on === 'object', args = Array.prototype.slice.call(arguments,1);
        exitFunction = function (sourceState, targetStateObj, event, args) {

            completed = true;
            /**
             * @event exit State exit event with the completed state name, at this point the state is no longer active.
             */
            sourceState.emit('exit',  targetStateObj, event, args);
            sourceState.active = false;
        };
        if (!completed) {
            var hasErrorHandler = hasOn && typeof stateDefinition.on.error === 'string';

            if (stateDefinition.type === 'end' || (!hasErrorHandler && event === 'error') ) {
                var flowCompleteEvent;
                if (event === 'error') { // no handler
                    if(EventEmitter.listenerCount(self, 'error') > 0 ) {
                        // error: no handler and no error event listener on the flow, end the flow with error
                        self.emit('error', error);
                    } else {
                        // error: no handler and there is an flow error listener, divert the error to there
                        flowCompleteEvent = 'error';
                    }
                } else if (hasOn && typeof stateDefinition.on[event] === 'string') {
                    // use the on mapping for end of flow event translation
                    flowCompleteEvent = stateDefinition.on[event];
                } else if (hasOn && typeof stateDefinition.on[''] === 'string') {
                    flowCompleteEvent = stateDefinition.on[''];
                } else {
                    flowCompleteEvent = event;
                }
                if (flowCompleteEvent !== undefined) {
                    exitFunction(stateObj, self, event, args);
                    flowCompleted(flowCompleteEvent, error);
                    completed = true;
                }
            } else if (hasOn && typeof stateDefinition.on[event] === 'string') {
                targetState = stateDefinition.on[event];
            } else if (hasOn && stateDefinition.on['*']) { // thinking of removing wildcard matches, since EventEmitter doesn't have a catch all
                targetState = stateDefinition.on['*'];
            } else if (hasOn && stateDefinition.on['']) {
                targetState = stateDefinition.on['']; // state complete is called directly when no action is defined, if there is also an empty handler (state -> next) then this will match
            }


            if (targetState && self.getStateObject(targetState) ) {
                exitFunction(stateObj, self.getStateObject(targetState), event, args );
                self.go(targetState, flowCompleted, event, args);
                completed = true;
            }
        }
        return completed;
    };

    return stateCompletion;
};
/**
 * Add a decorator, a decorator is function who is called on state creation, used to provide flow wide properties and methods.
 * Note it will not decorate itself (root flow), if this is desired the caller can always do flow.decorateState(flow); 
 * Decorators must be set before the flow is started
 * @param decoratorFunc {function(state)}
 */
StateFlow.prototype.addStateDecorator = function(decoratorFunc) {
    if(typeof decoratorFunc !== 'function') {
        throw new Error('decorator must be a function!');
    } else {
        if(!this._decorators) {
            this._decorators = [];
        }
        this._decorators.push(decoratorFunc);
    } 
};

StateFlow.prototype.decorateState = function(state) {
    if(this.parent) {
        this.parent.decorateState(state);
    }
    if(this._decorators) {
        // decorate in reverse order
        this._decorators.forEach(function(decorate) {
            decorate(state);
        });
    }
};


/**
 * Get the state instance object also associated with the state action this.
 * Used to provide functionality and data to a state see {State}.
 *
 * For every state there is state instance.
 * @param state {string} state name to get an state object for
 * @return {State} state instance object
 */
StateFlow.prototype.getStateObject = function (state) {
    //console.trace('getStateObject');
    if(!this.states[state]) {
        if (this.isSubFlowState(state)) {
            this.states[state] = new StateFlow(this.getSubFlowConfig(state), state, this );
        } else {
            this.states[state] = new State(this.config[state], state, this);
        }
        this.decorateState(this.states[state]);
    }
    return this.states[state];
};

StateFlow.prototype.createStateObject = function (state) {
    return this.getStateObject(state);
};

module.exports.StateFlow = StateFlow;
module.exports.State = State;
/**
 * Create a flow from a flow definition language
 * Syntax:
 *  state.action = myAction; // or any other property
 *  state.event -> next-state;
 *  
 *  Also:
 *  state.property = value
 * value can be either a boolean, number or string. 
 * Quoted strings accept all characters except the quote used. a literal string only allows alpha numeric and -
 * All actions must be registered with registerAction.
 * @param flowSource {string} source text of the simple flow language
 * @param name {string} flow name optional
 * @param parent {StateFlow} parent flow if this is a subflow
 * @param loader {function} resource loader
 */
module.exports.create = function(flowSource, name, parent, loader) {
    var def = parser(flowSource);

    return new StateFlow(def, name, parent);
};

/**
 * Load a flow and it's subflows
 * @param resource the name of the flow to load
 * @param loader  the loader which actually loads the name as a string, has to parameters the resource to load and the callback, the first argument is error or undefined and the second is the source string
 * @param cb
 */
module.exports.load = function(resource, loader, cb) {
    parser.load(resource, loader, function(err, config){
        var flow = config !== undefined ? new StateFlow(config) : undefined;
        cb(err, flow);
    });
};