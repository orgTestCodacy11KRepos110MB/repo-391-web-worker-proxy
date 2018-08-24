/* @flow */

type Worker = {
  +addEventListener: (name: 'message', cb: (e: any) => mixed) => mixed,
  +removeEventListener: (name: 'message', cb: (e: any) => mixed) => mixed,
  +postMessage: (data: mixed) => mixed,
};

const ACTION_GET = '__$$__WEB_WORKER_PROXY__ACTION_GET';
const ACTION_SET = '__$$__WEB_WORKER_PROXY__ACTION_SET';
const ACTION_APPLY = '__$$__WEB_WORKER_PROXY__ACTION_APPLY';

const RESULT_SUCCESS = '__$$__WEB_WORKER_PROXY__RESULT_SUCCESS';
const RESULT_ERROR = '__$$__WEB_WORKER_PROXY__RESULT_ERROR';
const RESULT_CALLBACK = '__$$__WEB_WORKER_PROXY__RESULT_CALLBACK';

const TYPE_FUNCTION = '__$$__WEB_WORKER_PROXY__TYPE_FUNCTION';

const uid = () =>
  Array.from({ length: 128 / 16 }, () =>
    Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1)
  ).join('');

const proxies = new WeakMap();

/**
 * Creates a proxied web worker.
 * This should be called in the DOM context.
 */
export function create(worker: Worker): any {
  // Create an empty object to be proxied
  // We don't actually proxy the worker instance
  const o = Object.create(null);

  // Send actions to the worker and wait for result
  const send = (type, data) =>
    new Promise((resolve, reject) => {
      // Unique id to identify the current action
      const id = uid();

      // For function calls, store any callbacks we're sending
      const callbacks = new Map();

      // Store a variable to indicate whether the task has been fulfilled
      let fulfilled = false;

      if (type === ACTION_APPLY) {
        /* $FlowFixMe */
        data.args = data.args.map(arg => {
          if (typeof arg === 'function') {
            const ref = uid();
            callbacks.set(ref, arg);
            return {
              type: TYPE_FUNCTION,
              ref,
            };
          }

          return arg;
        });
      }

      // Listener to handle incoming messages from the worker
      const listener = e => {
        switch (e.data.type) {
          case RESULT_SUCCESS:
            if (e.data.id === id) {
              // If the success result was for current action, resolve the promise
              resolve(e.data.result);

              fulfilled = true;

              removeListener();
            }

            break;

          case RESULT_ERROR:
            if (e.data.id === id) {
              // Try to get the global object
              const g =
                // DOM environment in browsers
                typeof window !== 'undefined'
                  ? window
                  : // Web worker environment
                    typeof self !== 'undefined'
                    ? self
                    : //Node environment
                      typeof global !== 'undefined'
                      ? // eslint-disable-next-line no-undef
                        global
                      : null;

              const { name, message, stack } = e.data.error;

              // If the error was for current action, reject the promise
              // Try to preserve the error constructor, e.g. TypeError
              const ErrorConstructor = g && g[name] ? g[name] : Error;

              const error = new ErrorConstructor(message);

              // Preserve the error stack
              error.stack = stack;

              reject(error);

              fulfilled = true;

              removeListener();
            }

            break;

          case RESULT_CALLBACK:
            if (e.data.id === id) {
              // Get the referenced callback
              const { ref, args } = e.data.func;
              const callback = callbacks.get(ref);

              if (callback) {
                callback(...args);

                // Remove the callback
                callbacks.delete(ref);
              } else {
                // The callback is already disposed
              }

              removeListener();
            }
        }
      };

      const removeListener = () => {
        if (callbacks.size === 0 && fulfilled) {
          // Remove the listener once there are no callbacks left and task is fulfilled
          worker.removeEventListener('message', listener);
        }
      };

      worker.addEventListener('message', listener);
      worker.postMessage({ type, id, data });
    });

  // Return a proxied object on which actions can be performed
  return new Proxy(o, {
    get(target, key) {
      const func = (...args) =>
        // It's a function call
        send(ACTION_APPLY, { key, args });

      // We execute the promise lazily and cache it here to avoid calling again
      let promise;

      const then = (succes, error) => {
        if (!promise) {
          // If the cached promise doesn't exist, create a new promise and cache it
          promise = send(ACTION_GET, { key });
        }

        return promise.then(succes, error);
      };

      // Here we intercept both function calls and property access
      // To intercept function calls, we return a function with `then` and `catch` methods
      // This makes sure that the result can be used like a promise in case it's a property access
      func.then = then;
      func.catch = error => then(null, error);

      return func;
    },
    set(target, key, value) {
      // Trigger setting the key
      // This might fail, but we can't throw an error synchornously
      // In case of a failure, the promise will be rejected and the browser will throw an error
      // If setting the property fails silently in the worker, this will also fail silently
      send(ACTION_SET, { key, value });

      // We can't know if set will succeed synchronously
      // So we always return true
      return true;
    },
  });
}

/**
 * Proxies an object inside an worker.
 * This should be called inside an worker.
 */
export function proxy(o: Object, target?: Worker = self) {
  if (proxies.has(target)) {
    throw new Error(
      'The specified target already has a proxy. To create a new proxy, call `dispose` first to dispose the previous proxy.'
    );
  }

  proxies.set(target, o);

  // Create an error response
  // Since we cannot send the error object, we send necessary info to recreate it
  const error = e => ({
    name: e.constructor.name,
    message: e.message,
    stack: e.stack,
  });

  // Listen to messages from the client
  const listener = e => {
    switch (e.data.type) {
      case ACTION_GET:
      case ACTION_SET:
      case ACTION_APPLY: {
        const { id, data } = e.data;

        try {
          let result;

          if (e.data.type === ACTION_SET) {
            // Reflect.set will return a boolean to indicate if setting the property was successful
            // Setting the property might fail if the object is read only
            result = Reflect.set(o, data.key, data.value);
          } else {
            const prop = o[data.key];

            if (e.data.type === ACTION_APPLY) {
              if (typeof prop !== 'function') {
                throw new TypeError(`${data.key} is not a function`);
              } else {
                result = prop(
                  ...data.args.map(arg => {
                    if (
                      typeof arg === 'object' &&
                      arg != null &&
                      arg.type === TYPE_FUNCTION
                    ) {
                      return (() => {
                        let called = false;

                        return (...params) => {
                          if (called) {
                            throw new Error(
                              'Cannot call callback multiple times'
                            );
                          }

                          called = true;
                          target.postMessage({
                            type: RESULT_CALLBACK,
                            id,
                            func: {
                              args: params,
                              ref: arg.ref,
                            },
                          });
                        };
                      })();
                    }

                    return arg;
                  })
                );
              }
            } else {
              result = prop;
            }
          }

          // If result is a thenable, resolve the result before sending
          // This allows us to support results which are promise-like
          /* $FlowFixMe */
          if (result && typeof result.then === 'function') {
            Promise.resolve(result).then(
              r => target.postMessage({ type: RESULT_SUCCESS, id, result: r }),
              e =>
                target.postMessage({
                  type: RESULT_ERROR,
                  id,
                  error: error(e),
                })
            );
          } else {
            target.postMessage({ type: RESULT_SUCCESS, id, result });
          }
        } catch (e) {
          target.postMessage({
            type: RESULT_ERROR,
            id,
            error: error(e),
          });
        }

        break;
      }
    }
  };

  target.addEventListener('message', listener);

  return {
    // Return a method to dispose the proxy
    // Disposing will remove the listeners and the proxy will stop working
    dispose: () => {
      target.removeEventListener('message', listener);
      proxies.delete(target);
    },
  };
}
