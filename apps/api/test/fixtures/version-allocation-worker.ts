import { createInterface } from 'node:readline';
import { DatabaseService } from '../../src/database.service.js';
import { FormulaService } from '../../src/formula.service.js';
import { IntelligenceService } from '../../src/intelligence.service.js';
import { claimNextJob } from '../../src/job-claim.js';
import type { SessionPrincipal } from '../../src/models.js';
import { ResearchService } from '../../src/research.service.js';
import { resolveOptions } from '../../src/config.js';

const dataDir = process.env.CONTENT_AGENT_DATA_DIR;
const databasePath = process.env.CONTENT_AGENT_DB_PATH;
if (!dataDir || !databasePath) throw new Error('worker database paths are required');

const options = resolveOptions({
  dataDir,
  databasePath,
  logger: false,
  platformApiKey: '',
  masterEncryptionKey: 'multi-instance-worker-key',
});
const database = new DatabaseService(options);
const audit = { record: () => undefined } as never;
const resources = { projectRow: () => ({ workspace_id: 'w1' }) } as never;
const principal: SessionPrincipal = {
  kind: 'session',
  userId: 'u1',
  username: 'multi-instance-fixture',
  systemRole: 'admin',
  userKind: 'research',
  mustChangePassword: false,
  tokenHash: 'worker-token',
  csrfHash: 'worker-csrf',
};
const formulas = new FormulaService(database, audit);
const research = new ResearchService(database, audit);
const intelligence = new IntelligenceService(database, resources, {} as never, audit, options);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

function versionOf(table: string, id: unknown): number {
  const row = database.prepare(`SELECT version FROM ${table} WHERE id=?`).get(String(id)) as { version: number };
  return Number(row.version);
}

process.stdout.write('READY\n');
for await (const raw of lines) {
  const command = JSON.parse(raw) as { id: string; operation: string; projectId?: string };
  const projectId = command.projectId ?? 'p1';
  process.stdout.write(`START ${command.id}\n`);
  try {
    let version: number | undefined;
    let claimedId: string | undefined;
    switch (command.operation) {
      case 'formula': {
        const result = formulas.create(projectId, { projectId, description: '并发公式草稿' }, principal);
        version = versionOf('formula_versions', result.id);
        break;
      }
      case 'ensure-default': {
        const result = formulas.ensureDefault(projectId, principal);
        version = versionOf('formula_versions', result.id);
        break;
      }
      case 'claim': {
        const result = research.createClaim(projectId, { logicalKey: 'parallel-claim', title: '并发主张', statement: '并发主张内容', claimType: 'hypothesis' }, principal);
        version = Number(result.version);
        break;
      }
      case 'source': {
        const result = research.createSource(projectId, { sourceKey: 'parallel-source', kind: 'test', citation: '并发证据来源' }, principal);
        version = Number(result.version);
        break;
      }
      case 'dataset': {
        const result = research.createDataset(projectId, { datasetKey: 'parallel-dataset', label: '并发数据集', kind: 'internal_sample', sha256: 'a'.repeat(64) }, principal);
        version = Number(result.version);
        break;
      }
      case 'experiment': {
        const result = research.createExperiment(projectId, { experimentKey: 'parallel-experiment', title: '并发实验', hypothesis: '并发实验假设' }, principal);
        version = Number(result.version);
        break;
      }
      case 'experiment-result': {
        const result = research.createExperimentResult(projectId, `${projectId}-experiment-parent`, { result: { sample: true }, conclusion: 'inconclusive' }, principal);
        version = Number(result.version);
        break;
      }
      case 'intelligence': {
        const result = intelligence.createIntelligence(projectId, { map: { source: 'parallel-worker' } }, principal);
        version = Number(result.version);
        break;
      }
      case 'bootstrap':
        research.bootstrapProject(projectId, 'u1');
        break;
      case 'claim-job':
        claimedId = claimNextJob(database, 'worker:claim-job', new Date().toISOString());
        break;
      default:
        throw new Error(`unknown operation: ${command.operation}`);
    }
    process.stdout.write(`RESULT ${JSON.stringify({ id: command.id, ok: true, version, claimedId })}\n`);
  } catch (error) {
    process.stdout.write(`RESULT ${JSON.stringify({
      id: command.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
  }
}

intelligence.onModuleDestroy();
database.onModuleDestroy();
