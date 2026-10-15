/** Classes, students, assignments, results (TZ §9 Classes, W-53, scenario «Учитель»). */
import { z } from 'zod';
import { KeySchema } from '../common.js';
import { PinSchema } from './auth.js';
import { DateTimeSchema, IdSchema } from './common.js';

export const ClassSchema = z.object({
  id: IdSchema,
  schoolId: IdSchema,
  name: z.string().min(1).max(40),
  grade: z.number().int().min(1).max(11),
  joinCode: z.string().regex(/^[A-Z0-9]{6}$/),
  joinCodeEnabled: z.boolean(),
  studentCount: z.number().int().min(0),
});
export type SchoolClass = z.infer<typeof ClassSchema>;

// POST /classes
export const ClassCreateRequestSchema = z.object({
  name: z.string().min(1).max(40),
  grade: z.number().int().min(1).max(11),
  /** Required for school admins with several schools; defaults to the teacher's school. */
  schoolId: IdSchema.optional(),
});
export type ClassCreateRequest = z.infer<typeof ClassCreateRequestSchema>;

// PATCH /classes/:id
export const ClassPatchRequestSchema = z
  .object({
    name: z.string().min(1).max(40),
    grade: z.number().int().min(1).max(11),
    joinCodeEnabled: z.boolean(),
  })
  .partial();
export type ClassPatchRequest = z.infer<typeof ClassPatchRequestSchema>;

// POST /classes/:id/join-code → re-issue
export const JoinCodeResponseSchema = z.object({ joinCode: z.string().regex(/^[A-Z0-9]{6}$/) });

export const StudentSchema = z.object({
  id: IdSchema,
  classId: IdSchema,
  /** Name or pseudonym — the only personal data stored about a child (TZ §6). */
  displayName: z.string().min(1).max(80),
  /** School confirmed a parental consent form is on file. */
  hasConsent: z.boolean(),
});
export type Student = z.infer<typeof StudentSchema>;

// POST /classes/:id/students — a list or a CSV (one name per line)
export const StudentsAddRequestSchema = z.union([
  z.object({ students: z.array(z.object({ displayName: z.string().min(1).max(80) })).min(1).max(200) }),
  z.object({ csv: z.string().min(1).max(200_000) }),
]);
export type StudentsAddRequest = z.infer<typeof StudentsAddRequestSchema>;
/** PINs are returned once, for printing login cards. */
export const StudentsAddResponseSchema = z.object({
  items: z.array(z.object({ student: StudentSchema, pin: PinSchema })),
});
export type StudentsAddResponse = z.infer<typeof StudentsAddResponseSchema>;

// POST /students/:id/reset-pin
export const ResetPinResponseSchema = z.object({ pin: PinSchema });

export const ASSIGNMENT_ACTIVITIES = ['tour', 'quiz', 'process', 'comparison'] as const;
export const AssignmentActivitySchema = z.enum(ASSIGNMENT_ACTIVITIES);

// POST /classes/:id/assignments
export const AssignmentCreateRequestSchema = z.object({
  topicKey: KeySchema,
  activities: z.array(AssignmentActivitySchema).min(1),
  dueAt: DateTimeSchema.optional(),
});
export type AssignmentCreateRequest = z.infer<typeof AssignmentCreateRequestSchema>;

export const AssignmentSchema = AssignmentCreateRequestSchema.extend({
  id: IdSchema,
  classId: IdSchema,
  createdBy: IdSchema,
  createdAt: DateTimeSchema,
});
export type Assignment = z.infer<typeof AssignmentSchema>;

// GET /assignments/:id/results
export const AssignmentResultsSchema = z.object({
  assignmentId: IdSchema,
  students: z.array(
    z.object({
      studentId: IdSchema,
      displayName: z.string(),
      status: z.enum(['not_started', 'in_progress', 'done']),
      score: z.number().min(0).max(1).optional(),
      finishedAt: DateTimeSchema.optional(),
    }),
  ),
  averageScore: z.number().min(0).max(1).nullable(),
  /** «Самые сложные вопросы»: lowest correct rate first. */
  hardestItems: z.array(
    z.object({
      itemKey: KeySchema,
      correctRate: z.number().min(0).max(1),
      /** Most frequent wrong option key, if any. */
      commonWrong: z.string().optional(),
    }),
  ),
});
export type AssignmentResults = z.infer<typeof AssignmentResultsSchema>;
