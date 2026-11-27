import { IagentProfileScreen, ProfileSettingsScreen } from '@/frontend/features/settings/profile';
import { isIagentEdition } from '@/shared/utils/iagentEdition';

export default function Profile() {
  return isIagentEdition() ? <IagentProfileScreen /> : <ProfileSettingsScreen />;
}
