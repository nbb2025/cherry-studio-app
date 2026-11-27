import { IagentLoginScreen, LoginRoute } from '@/frontend/appShell/account/login';
import { isIagentEdition } from '@/shared/utils/iagentEdition';

export default function Login() {
  return isIagentEdition() ? <IagentLoginScreen /> : <LoginRoute />;
}
