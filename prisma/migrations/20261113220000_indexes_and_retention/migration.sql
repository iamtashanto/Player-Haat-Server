-- Indexes on foreign keys that are filtered, joined or cascaded on (found by an audit of the schema).
CREATE INDEX IF NOT EXISTS "PlayerRequest_teamId_idx" ON "PlayerRequest"("teamId");
CREATE INDEX IF NOT EXISTS "PlayerRequest_opponentTeamId_idx" ON "PlayerRequest"("opponentTeamId");
CREATE INDEX IF NOT EXISTS "Rating_raterId_idx" ON "Rating"("raterId");
CREATE INDEX IF NOT EXISTS "Message_senderId_idx" ON "Message"("senderId");
CREATE INDEX IF NOT EXISTS "GameMessage_senderId_idx" ON "GameMessage"("senderId");
CREATE INDEX IF NOT EXISTS "ProfileView_viewerId_idx" ON "ProfileView"("viewerId");
CREATE INDEX IF NOT EXISTS "ProfileView_createdAt_idx" ON "ProfileView"("createdAt");
CREATE INDEX IF NOT EXISTS "ShortlistEntry_profileId_idx" ON "ShortlistEntry"("profileId");
CREATE INDEX IF NOT EXISTS "Invite_requestId_idx" ON "Invite"("requestId");
CREATE INDEX IF NOT EXISTS "VerificationCode_userId_idx" ON "VerificationCode"("userId");
CREATE INDEX IF NOT EXISTS "Report_reporterId_idx" ON "Report"("reporterId");
