import { StartupInteractiveMarker } from '@/frontend/appShell/observability';
import { ChatScreen, IagentChatScreen } from '@/frontend/features/chat';
import { isIagentEdition } from '@/shared/utils/iagentEdition';

export default function ChatRoute() {
  if (isIagentEdition()) return <IagentChatScreen />;
  return (
    <>
      <StartupInteractiveMarker />
      <ChatScreen />
    </>
  );
}
