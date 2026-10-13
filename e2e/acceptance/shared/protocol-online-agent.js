const fs = require('node:fs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('WebSocket open timeout'));
    }, 5_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket open failed'));
    }, { once: true });
  });
}

function request(socket, msgType, payload, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(msgType + ' response timeout'));
    }, 5_000);
    const onMessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (parsed.id !== id || parsed.msg_type !== msgType) return;
      cleanup();
      resolve(parsed);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('socket closed while waiting for ' + msgType));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.send(JSON.stringify({
      msg_type: msgType,
      id,
      timestamp: Date.now(),
      payload,
    }));
  });
}

async function verifyOnlineAgent(runtime) {
  const socket = await openSocket('ws://127.0.0.1:' + runtime.server_port + '/ws');
  try {
    const auth = await request(socket, 'server.auth', {
      auth_token: 'e2e-test-token',
      client_id: null,
    }, 'acceptance-auth');
    if (auth.payload?.status !== 'success') {
      throw new Error('server.auth did not succeed: ' + JSON.stringify(auth.payload));
    }

    let agents = [];
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const reply = await request(socket, 'server.agent.list', {}, 'acceptance-agents-' + Date.now());
      if (Array.isArray(reply.payload?.agents)) {
        agents = reply.payload.agents;
        if (agents.some((agent) => agent.agent_id === 'e2e-test-node')) break;
      }
      await sleep(250);
    }
    const agent = agents.find((item) => item.agent_id === 'e2e-test-node');
    if (!agent) throw new Error('real Agent did not register with Server within verifier deadline');

    return {
      status: 'pass',
      summary: 'Protocol verifier authenticated to the real Server and observed the real Agent registration.',
      evidence: [
        {
          type: 'protocol',
          value: 'server.auth status=success over ws://127.0.0.1:' + runtime.server_port + '/ws',
        },
        {
          type: 'protocol',
          value: 'server.agent.list contains agent_id=e2e-test-node status=' + agent.status,
        },
        {
          type: 'runtime',
          value: 'target_sha=' + runtime.target_sha + ' profile=' + runtime.profile,
        },
      ],
    };
  } finally {
    socket.close();
  }
}

function runtimeFromEnv() {
  const runtimeFile = process.env.NESSION_ACCEPTANCE_RUNTIME_FILE;
  if (!runtimeFile) throw new Error('NESSION_ACCEPTANCE_RUNTIME_FILE is required');
  return JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
}

module.exports = { runtimeFromEnv, verifyOnlineAgent };
