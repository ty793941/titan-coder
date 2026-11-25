#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/client';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import {
  ControlPlaneClient,
  Dispatcher,
  WorkflowClientError,
  connectTemporalClient,
  resolveWorkflowBearer,
} from '@titan/workflow';
import type { OrchestrationActivities } from '@titan/workflow';
import { loadWorkerConfig, type WorkerConfig } from './config.js';

export async function runSafeActivity<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const safe = error instanceof WorkflowClientError
      ? error
      : new WorkflowClientError('WORKFLOW_COMMAND_FAILED', false);
    const failure = ApplicationFailure.create({
      message: safe.code,
      type: safe.code,
      nonRetryable: !safe.retryable,
    });
    failure.stack = '';
    throw failure;
  }
}

export async function runWorker(config: WorkerConfig): Promise<void> {
  const runtime = Runtime.install({ shutdownSignals: [] });
  let controlPlane: ControlPlaneClient | undefined;
  let temporal: Awaited<ReturnType<typeof connectTemporalClient>> | undefined;
  let nativeConnection: NativeConnection | undefined;
  let worker: Worker | undefined;
  let dispatcher: Dispatcher | undefined;
  let dispatcherRun: Promise<void> | undefined;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (dispatcher) await dispatcher.stop();
    if (worker && !['STOPPED', 'FAILED'].includes(worker.getState())) {
      try { worker.shutdown(); } catch { /* Worker may have completed shutdown concurrently. */ }
    }
  };
  const onSignal = () => { void shutdown(); };
  let signalHandlersInstalled = false;
  try {
    controlPlane = new ControlPlaneClient({ baseUrl: config.controlPlaneUrl, bearer: await resolveWorkflowBearer(config.credentialRef), requestTimeoutMs: config.requestTimeoutMs });
    const controlPlaneClient = controlPlane;
    temporal = await connectTemporalClient({ address: config.temporalAddress, namespace: config.namespace, taskQueue: config.taskQueue });
    nativeConnection = await NativeConnection.connect({ address: config.temporalAddress });
    const activities: OrchestrationActivities = {
      dispatchJob: (input) => runSafeActivity(() => controlPlaneClient.dispatchJob(input)),
      observeJob: (input) => runSafeActivity(() => controlPlaneClient.observeJob(input)),
      cancelJob: (input) => runSafeActivity(() => controlPlaneClient.cancelJob(input)),
      failJob: (input) => runSafeActivity(() => controlPlaneClient.failJob(input)),
      scheduleOccurrence: (input) => runSafeActivity(() => controlPlaneClient.scheduleOccurrence(input)),
    };
    worker = await Worker.create({
      connection: nativeConnection,
      namespace: config.namespace,
      taskQueue: config.taskQueue,
      workflowsPath: fileURLToPath(new URL('../../../packages/workflow/dist/src/workflows.js', import.meta.url)),
      activities,
    });
    dispatcher = new Dispatcher({ controlPlane: controlPlaneClient, temporal, workerId: config.workerId, pollIntervalMs: config.pollIntervalMs });
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    signalHandlersInstalled = true;
    dispatcherRun = dispatcher.start();
    await worker.run();
    await dispatcherRun;
  } finally {
    await shutdown();
    if (signalHandlersInstalled) {
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
    }
    if (nativeConnection) {
      try { await nativeConnection.close(); } catch { /* Cleanup errors are intentionally not exposed. */ }
    }
    if (temporal) {
      try { await temporal.close(); } catch { /* Cleanup errors are intentionally not exposed. */ }
    }
    try { await runtime.shutdown(); } catch { /* Cleanup errors are intentionally not exposed. */ }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void loadWorkerConfig(process.argv.slice(2)).then(runWorker).catch((error: unknown) => {
    const message = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'WORKFLOW_WORKER_FAILED';
    process.stderr.write(`${message}\n`);
    process.exitCode = message === 'WORKFLOW_CONFIG_INVALID' ? 2 : 1;
  });
}
