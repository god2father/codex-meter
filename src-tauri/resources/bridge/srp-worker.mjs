import { parentPort, workerData } from 'node:worker_threads';
import { clientExchange } from './srp.mjs';
parentPort.postMessage(clientExchange(workerData.code, workerData.salt, workerData.publicKey));
