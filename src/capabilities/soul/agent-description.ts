export interface DiscoveredCapability {
  name: string;
  description: string;
}

export interface CapabilityDiscoveryInput {
  channelNames: string[];
  skillNames: string[];
  hasScheduler: boolean;
}

const CHANNEL_DESCRIPTIONS: Record<string, string> = {
  whatsapp: 'Can send and receive WhatsApp messages',
  telegram: 'Can send and receive Telegram messages',
  voice: 'Can receive and respond to voice notes',
  discord: 'Can send and receive Discord messages',
  gmail: 'Can read and send email via Gmail',
};

export function discoverCapabilities(
  opts: CapabilityDiscoveryInput,
): DiscoveredCapability[] {
  const out: DiscoveredCapability[] = [];

  for (const channel of opts.channelNames) {
    const desc =
      CHANNEL_DESCRIPTIONS[channel] ?? `Can send and receive ${channel} messages`;
    out.push({ name: `${channel}-messaging`, description: desc });
  }

  out.push({
    name: 'web-browsing',
    description:
      'Can browse the web, extract content, fill forms, take screenshots',
  });
  out.push({
    name: 'file-management',
    description: 'Can read, write, and organize files within sandboxed workspace',
  });
  out.push({
    name: 'shell-execution',
    description: 'Can run bash commands inside an isolated container sandbox',
  });

  if (opts.hasScheduler) {
    out.push({
      name: 'scheduling',
      description: 'Can create and manage recurring or one-time tasks',
    });
  }

  for (const skill of opts.skillNames) {
    out.push({
      name: `skill:${skill}`,
      description: `Skill bundled with this agent: ${skill}`,
    });
  }

  return out;
}

export interface AgentDescriptionInput {
  domain: string;
  agentName: string;
  owner: string;
  description?: string;
  traits?: string[];
  channelNames: string[];
  skillNames: string[];
  hasScheduler: boolean;
  now?: Date;
}

export function generateAgentDescription(opts: AgentDescriptionInput): object {
  const did = `did:wba:${opts.domain}:agent:${opts.agentName}`;
  const now = (opts.now ?? new Date()).toISOString();
  const capabilities = discoverCapabilities({
    channelNames: opts.channelNames,
    skillNames: opts.skillNames,
    hasScheduler: opts.hasScheduler,
  });

  return {
    '@context': {
      '@vocab': 'https://schema.org/',
      anp: 'https://agent-network-protocol.com/ns/',
      did: 'https://www.w3.org/ns/did/v1',
    },
    '@type': 'anp:AgentDescription',
    name: opts.agentName,
    description:
      opts.description ?? `Personal AI assistant operated by ${opts.owner}.`,
    url: `https://${opts.domain}`,
    identifier: did,
    owner: {
      '@type': 'Person',
      name: opts.owner,
    },
    ...(opts.traits && opts.traits.length > 0 ? { 'anp:traits': opts.traits } : {}),
    'anp:capabilities': capabilities.map((c) => ({
      '@type': 'anp:Capability',
      name: c.name,
      description: c.description,
    })),
    'anp:protocols': [
      {
        '@type': 'anp:Protocol',
        name: 'a2a',
        version: '0.3',
        endpoint: `https://${opts.domain}/a2a`,
      },
    ],
    'anp:trustLevel': 'owner-verified',
    'anp:verificationLevels': ['cryptographic', 'owner-verified'],
    'anp:onChainIdentity': {
      '@type': 'anp:OnChainIdentity',
      standard: 'ERC-8004',
      chain: null,
      agentId: null,
      registryAddresses: {
        ethereum: {
          identity: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
          reputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
        },
        'avalanche-c': { identity: null, reputation: null },
        bnb: { identity: null, reputation: null },
      },
      _comment:
        'Null in v1. Set chain + agentId when soul is registered on-chain (ERC-8004).',
    },
    'anp:uptime': 'continuous',
    'anp:lastSeen': now,
  };
}
