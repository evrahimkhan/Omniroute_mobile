import React from 'react';

import GatewayTab from '../../components/GatewayTab';

/** Models — the model catalog across all 358 providers. */
export default function ModelsScreen() {
  return <GatewayTab path="/dashboard/models" title="Model Catalog" />;
}
