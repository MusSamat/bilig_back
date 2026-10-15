-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "email" TEXT,
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "displayName" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Credential" (
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("userId","type")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "refreshHash" TEXT NOT NULL,
    "family" UUID NOT NULL,
    "audience" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "ip" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "replacedById" UUID,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleAssignment" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL DEFAULT '',
    "subrole" TEXT,

    CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT,
    "subrole" TEXT,
    "tokenHash" TEXT NOT NULL,
    "invitedBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "School" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "School_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "License" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "subjects" TEXT[],
    "grades" INTEGER[],
    "seats" INTEGER NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "License_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Class" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "grade" INTEGER NOT NULL,
    "joinCode" TEXT NOT NULL,
    "joinCodeEnabled" BOOLEAN NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Class_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "classId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("classId","userId")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "studentId" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "confirmedBy" UUID NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("studentId")
);

-- CreateTable
CREATE TABLE "SubjectGroup" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "doc" JSONB NOT NULL,
    "subjectKey" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "SubjectGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subject" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "doc" JSONB NOT NULL,
    "subjectKey" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL,
    "groupKey" TEXT,
    "icon" TEXT,
    "hue" INTEGER,
    "order" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Course" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "doc" JSONB NOT NULL,
    "subjectKey" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL,
    "grade" INTEGER,
    "curriculum" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Unit" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "doc" JSONB NOT NULL,
    "subjectKey" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL,
    "courseKey" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Objective" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "doc" JSONB NOT NULL,
    "subjectKey" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL,
    "unitKey" TEXT,
    "code" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "Objective_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Concept" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "doc" JSONB NOT NULL,
    "subjectKey" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL,
    "kind" TEXT,
    "hue" INTEGER,
    "isContainer" BOOLEAN NOT NULL DEFAULT false,
    "related" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "Concept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Process" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "doc" JSONB NOT NULL,
    "subjectKey" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL,
    "engine" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "Process_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "doc" JSONB NOT NULL,
    "subjectKey" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL,
    "type" TEXT,
    "difficulty" INTEGER,
    "objectiveKeys" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlossaryTerm" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "doc" JSONB NOT NULL,
    "subjectKey" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "GlossaryTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Topic" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "unitKey" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "demo" BOOLEAN NOT NULL DEFAULT false,
    "publishedVersionId" UUID,
    "latestVersionId" UUID,
    "scheduledAt" TIMESTAMPTZ(3),
    "scheduledVersionId" UUID,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopicVersion" (
    "id" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "topicKey" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "doc" JSONB NOT NULL,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "reviewState" TEXT NOT NULL,
    "message" TEXT,

    CONSTRAINT "TopicVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Build" (
    "id" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "topicKey" TEXT NOT NULL,
    "topicVersionId" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "manifest" JSONB,
    "package" JSONB,
    "packageUrl" TEXT,
    "hash" TEXT,
    "log" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Build_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sizeAfter" INTEGER,
    "triangles" INTEGER,
    "nodes" JSONB NOT NULL,
    "violations" JSONB NOT NULL,
    "originalUrl" TEXT,
    "optimizedUrl" TEXT,
    "thumbUrl" TEXT,
    "uploadId" TEXT NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocaleString" (
    "key" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LocaleString_pkey" PRIMARY KEY ("key","locale")
);

-- CreateTable
CREATE TABLE "ReviewComment" (
    "id" UUID NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ReviewComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Progress" (
    "userId" UUID NOT NULL,
    "topicKey" TEXT NOT NULL,
    "visitedConcepts" TEXT[],
    "completedActivities" TEXT[],
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Progress_pkey" PRIMARY KEY ("userId","topicKey")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "topicKey" TEXT NOT NULL,
    "activities" TEXT[],
    "dueAt" TIMESTAMPTZ(3),
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attempt" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "assignmentId" UUID,
    "topicKey" TEXT NOT NULL,
    "topicVersion" TEXT NOT NULL,
    "topicVersionId" UUID NOT NULL,
    "seed" TEXT NOT NULL,
    "itemKeys" TEXT[],
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "score" DOUBLE PRECISION,
    "source" TEXT NOT NULL,

    CONSTRAINT "Attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Answer" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "itemKey" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "correct" BOOLEAN NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "timeMs" INTEGER NOT NULL,
    "answeredAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Answer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningEvent" (
    "id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "verb" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "topicKey" TEXT,
    "result" JSONB,
    "context" JSONB,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LearningEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "userId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("userId","key")
);

-- CreateTable
CREATE TABLE "Presentation" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "topicKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "slides" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Presentation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Snapshot" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "topicKey" TEXT NOT NULL,
    "topicVersion" TEXT NOT NULL,
    "imageKey" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "sceneState" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TutorThread" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "topicKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TutorThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TutorMessage" (
    "id" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "citations" TEXT[],
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "flagged" BOOLEAN NOT NULL,
    "topicKey" TEXT NOT NULL,
    "schoolId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TutorMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "diff" JSONB,
    "ip" TEXT,
    "ts" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshHash_key" ON "Session"("refreshHash");

-- CreateIndex
CREATE INDEX "Session_family_idx" ON "Session"("family");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "RoleAssignment_scopeType_scopeId_idx" ON "RoleAssignment"("scopeType", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleAssignment_userId_role_scopeType_scopeId_key" ON "RoleAssignment"("userId", "role", "scopeType", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_scopeType_scopeId_idx" ON "Invite"("scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "License_schoolId_idx" ON "License"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "Class_joinCode_key" ON "Class"("joinCode");

-- CreateIndex
CREATE INDEX "Class_schoolId_idx" ON "Class"("schoolId");

-- CreateIndex
CREATE INDEX "Enrollment_userId_idx" ON "Enrollment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SubjectGroup_key_key" ON "SubjectGroup"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Subject_key_key" ON "Subject"("key");

-- CreateIndex
CREATE INDEX "Subject_subjectKey_idx" ON "Subject"("subjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "Course_key_key" ON "Course"("key");

-- CreateIndex
CREATE INDEX "Course_subjectKey_idx" ON "Course"("subjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_key_key" ON "Unit"("key");

-- CreateIndex
CREATE INDEX "Unit_subjectKey_idx" ON "Unit"("subjectKey");

-- CreateIndex
CREATE INDEX "Unit_courseKey_idx" ON "Unit"("courseKey");

-- CreateIndex
CREATE UNIQUE INDEX "Objective_key_key" ON "Objective"("key");

-- CreateIndex
CREATE INDEX "Objective_subjectKey_idx" ON "Objective"("subjectKey");

-- CreateIndex
CREATE INDEX "Objective_unitKey_idx" ON "Objective"("unitKey");

-- CreateIndex
CREATE UNIQUE INDEX "Concept_key_key" ON "Concept"("key");

-- CreateIndex
CREATE INDEX "Concept_subjectKey_idx" ON "Concept"("subjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "Process_key_key" ON "Process"("key");

-- CreateIndex
CREATE INDEX "Process_subjectKey_idx" ON "Process"("subjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "Item_key_key" ON "Item"("key");

-- CreateIndex
CREATE INDEX "Item_subjectKey_idx" ON "Item"("subjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "GlossaryTerm_key_key" ON "GlossaryTerm"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Topic_key_key" ON "Topic"("key");

-- CreateIndex
CREATE INDEX "Topic_subjectKey_idx" ON "Topic"("subjectKey");

-- CreateIndex
CREATE INDEX "Topic_scheduledAt_idx" ON "Topic"("scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "TopicVersion_topicId_version_key" ON "TopicVersion"("topicId", "version");

-- CreateIndex
CREATE INDEX "Build_topicVersionId_status_idx" ON "Build"("topicVersionId", "status");

-- CreateIndex
CREATE INDEX "Build_topicKey_idx" ON "Build"("topicKey");

-- CreateIndex
CREATE INDEX "LocaleString_locale_status_idx" ON "LocaleString"("locale", "status");

-- CreateIndex
CREATE INDEX "ReviewComment_targetType_targetId_idx" ON "ReviewComment"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "Assignment_classId_idx" ON "Assignment"("classId");

-- CreateIndex
CREATE INDEX "Attempt_assignmentId_idx" ON "Attempt"("assignmentId");

-- CreateIndex
CREATE INDEX "Attempt_startedAt_idx" ON "Attempt"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Attempt_userId_clientId_key" ON "Attempt"("userId", "clientId");

-- CreateIndex
CREATE INDEX "Answer_itemKey_idx" ON "Answer"("itemKey");

-- CreateIndex
CREATE UNIQUE INDEX "Answer_attemptId_itemKey_key" ON "Answer"("attemptId", "itemKey");

-- CreateIndex
CREATE INDEX "LearningEvent_ts_idx" ON "LearningEvent"("ts");

-- CreateIndex
CREATE INDEX "Presentation_ownerId_idx" ON "Presentation"("ownerId");

-- CreateIndex
CREATE INDEX "Snapshot_ownerId_idx" ON "Snapshot"("ownerId");

-- CreateIndex
CREATE INDEX "TutorMessage_threadId_idx" ON "TutorMessage"("threadId");

-- CreateIndex
CREATE INDEX "TutorMessage_createdAt_idx" ON "TutorMessage"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_idx" ON "AuditLog"("targetType");

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "License" ADD CONSTRAINT "License_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Class" ADD CONSTRAINT "Class_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicVersion" ADD CONSTRAINT "TopicVersion_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Build" ADD CONSTRAINT "Build_topicVersionId_fkey" FOREIGN KEY ("topicVersionId") REFERENCES "TopicVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TutorMessage" ADD CONSTRAINT "TutorMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "TutorThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
