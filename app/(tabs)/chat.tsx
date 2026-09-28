import React from 'react';

import GatewayTab from '../../components/GatewayTab';

/** Chat — the OmniRoute Playground: try any model through the gateway. */
export default function ChatScreen() {
  return <GatewayTab path="/dashboard/playground" title="Playground" />;
}
