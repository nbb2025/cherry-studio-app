import { isEnterpriseProfile } from '@/shared/data/activeProfile';
import { isIagentEdition } from '@/shared/utils/iagentEdition';

const COMMUNITY_LOGO = require('@/assets/cherry-studio-logo.png');
const ENTERPRISE_LOGO = require('@/assets/enterprise-logo.png');
const IAGENT_LOGO = require('@/assets/iagent-mark.png');

/** Profile selection is fixed before React loads; switching spaces reloads this runtime. */
export function getAppLogo() {
  if (isIagentEdition()) return IAGENT_LOGO;
  return isEnterpriseProfile() ? ENTERPRISE_LOGO : COMMUNITY_LOGO;
}
