/** English (source) messages for Wave F5A Failover, Health & Network Settings (`#157`, `#167`, `#172`). */
export const enFailoverNetworkMessages = {
  // #157 Multi-Source Failover Channel Groups
  'channels.manage.tab.failover': 'Failover',
  'channels.failover.title': 'Failover Groups',
  'channels.failover.subtitle':
    'Group matching channels across sources in priority order for automatic backup switching.',
  'channels.failover.autoMatch': 'Auto-match channels',
  'channels.failover.applySuggestions': 'Apply {count} suggested groups',
  'channels.failover.noSuggestions': 'No new cross-source matches found.',
  'channels.failover.createPlaceholder': 'New failover group name',
  'channels.failover.create': 'Create group',
  'channels.failover.empty':
    'No failover groups yet. Add multiple sources or create a group manually.',
  'channels.failover.memberCount': '{count} sources',
  'channels.failover.priorityBadge': '#{rank}',
  'channels.failover.primaryBadge': 'Primary',
  'channels.failover.moveUp': 'Move up',
  'channels.failover.moveDown': 'Move down',
  'channels.failover.addChannel': 'Add channel',
  'channels.failover.removeMember': 'Remove',
  'channels.failover.deleteGroup': 'Delete group',
  'channels.failover.selectChannelHint': 'Choose a live channel to add to this failover group.',

  // #167 Passive Stream Health Badges
  'live.health.flaky': 'Unstable',
  'live.health.dead': 'Offline',
  'live.health.healthy': 'Healthy',

  // #172 Per-Source Advanced Network Settings
  'sources.network.title': 'Network',
  'sources.network.dnsFamilyLabel': 'DNS IP preference',
  'sources.network.dnsFamily.system': 'System',
  'sources.network.dnsFamily.ipv4': 'IPv4 only',
  'sources.network.dnsFamily.ipv6': 'IPv6 only',
  'sources.network.hostOverrideLabel': 'Host IP override (optional)',
  'sources.network.hostOverridePlaceholder': 'e.g. 203.0.113.10 or 2001:db8::1',
  'sources.network.hostOverrideHint':
    'Connects directly to this IP while keeping original TLS certificate verification.',
  'sources.network.invalidHostOverride':
    'Enter a valid IPv4 or IPv6 address without ports or schemes.',
  'sources.network.backupServersLabel': 'Backup server URLs (optional)',
  'sources.network.backupServersPlaceholder': 'One URL per line',
  'sources.network.save': 'Save network settings',
  'sources.network.saved': 'Network settings saved',
} as const;

/** Message identifiers for Wave F5A Failover, Health & Network Settings. */
export type FailoverNetworkMessageId = keyof typeof enFailoverNetworkMessages;
