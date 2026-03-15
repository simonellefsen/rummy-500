import { GameLobbyClient } from "../../../components/game-lobby-client";

export default async function GamePage({
  params
}: {
  params: Promise<{ gameId: string }>;
}) {
  const { gameId } = await params;

  return <GameLobbyClient gameId={gameId} />;
}
