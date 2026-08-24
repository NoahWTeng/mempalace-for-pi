import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import { closeSync, openSync, appendFileSync } from 'node:fs';

const evidence = process.env.MEMPALACE_NETWORK_EVIDENCE;
if (!evidence) throw new Error('MEMPALACE_NETWORK_EVIDENCE is required');
closeSync(openSync(evidence, 'a'));

const loopback = (host) => typeof host === 'string' && (
  host === 'localhost' || host === '::1' || host.startsWith('127.')
);
const block = (api, host, port = '') => {
  appendFileSync(evidence, `node ${api} ${String(host)}${port === '' ? '' : `:${String(port)}`}\n`);
  throw new Error(`routine non-loopback network blocked by ${api}: ${String(host)}`);
};

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' && first !== null
    ? first
    : { port: first, host: args[1] };
  if (typeof options.path === 'string' && options.path) return originalConnect.apply(this, args);
  if (!loopback(options.host)) block('net.connect', options.host, options.port);
  return originalConnect.apply(this, args);
};

for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  const original = dns[name].bind(dns);
  dns[name] = function guardedDns(host, ...args) {
    if (!loopback(host)) block(`dns.${name}`, host);
    return original(host, ...args);
  };
  if (typeof dns.promises?.[name] === 'function') {
    const originalPromise = dns.promises[name].bind(dns.promises);
    dns.promises[name] = function guardedDnsPromise(host, ...args) {
      if (!loopback(host)) block(`dns.promises.${name}`, host);
      return originalPromise(host, ...args);
    };
  }
}

const connectedDatagrams = new WeakSet();
const originalDgramConnect = dgram.Socket.prototype.connect;
dgram.Socket.prototype.connect = function guardedDgramConnect(...args) {
  const address = typeof args[1] === 'string' ? args[1] : undefined;
  if (!loopback(address)) block('dgram.connect', address, args[0]);
  connectedDatagrams.add(this);
  return originalDgramConnect.apply(this, args);
};
const originalDgramSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function guardedDgramSend(...args) {
  const values = typeof args.at(-1) === 'function' ? args.slice(0, -1) : args;
  const address = values.length >= 3 && typeof values.at(-1) === 'string' ? values.at(-1) : undefined;
  const port = address === undefined ? undefined : values.at(-2);
  if (address === undefined ? !connectedDatagrams.has(this) : !loopback(address)) {
    block('dgram.send', address, port);
  }
  return originalDgramSend.apply(this, args);
};
