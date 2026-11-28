import { createHash } from 'node:crypto';
import { workProposalConfirmationSchema, workProposalSchema } from '../../../packages/contracts/dist/index.js';

export async function acceptWorkProposal({ projectId, input, conversations, controlPlaneUrl, consoleToken }) {
  const confirmation = workProposalConfirmationSchema.parse(input);
  const snapshot = await conversations.request('read', projectId);
  if (snapshot.projectId !== projectId) throw new Error('CONVERSATION_PROPOSAL_CONFLICT');
  const turn = snapshot.turns.find(item => item.id === confirmation.turnId);
  if (!turn) throw new Error('NOT_FOUND');
  if (turn.status !== 'completed' || turn.mode !== 'work-proposal' || !turn.proposal)
    throw new Error('CONVERSATION_PROPOSAL_CONFLICT');
  const proposal = workProposalSchema.parse(turn.proposal);
  const checksum = `sha256:${createHash('sha256').update(JSON.stringify(proposal)).digest('hex')}`;
  if (turn.proposalChecksum !== checksum || confirmation.proposalChecksum !== checksum)
    throw new Error('CONVERSATION_PROPOSAL_CONFLICT');
  let response;
  try {
    response = await fetch(`${controlPlaneUrl}/api/projects/${projectId}/work-proposals/accept`, {
      method: 'POST',
      headers: { authorization: `Bearer ${consoleToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sourceTurnId: turn.id, proposalChecksum: checksum, confirmed: true, proposal }),
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
  } catch { throw new Error('CONTROL_PLANE_UNAVAILABLE'); }
  if (response.status === 409) throw new Error('CONVERSATION_PROPOSAL_CONFLICT');
  if (response.status === 404) throw new Error('NOT_FOUND');
  if (!response.ok) throw new Error('CONTROL_PLANE_UNAVAILABLE');
  return response.json();
}
