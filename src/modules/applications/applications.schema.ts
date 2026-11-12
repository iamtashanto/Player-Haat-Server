import { pageQuery } from "../../lib/pagination.js";
import { registerRoute } from "../../lib/openapi.js";
import { z } from "../../lib/zod.js";

export const applyBody = z
  .strictObject({
    proposedRate: z.number().int().min(0).max(1_000_000).nullable().optional().openapi({ description: "BDT. Only for paid requests." }),
    message: z.string().trim().max(300).nullable().optional(),
  })
  .default({}); // a bare POST with no body is a valid "just apply"
const status = z.enum(["PENDING", "ACCEPTED", "REJECTED", "WITHDRAWN", "WAITLISTED"]);
export const applicantsQuery = pageQuery.extend({ status: status.optional() });
export const myApplicationsQuery = pageQuery.extend({ status: status.optional() });
export const requestIdParams = z.object({ requestId: z.string().min(1).max(40) });
export const feePaidBody = z.strictObject({ paid: z.boolean() });
export const applicationParams = z.object({ id: z.string().min(1).max(40) });

const Contact = z.object({ phone: z.string().nullable() }).openapi({ description: "Only present once the application is ACCEPTED; each side sees the other's number." });
const Base = {
  id: z.string(),
  status,
  proposedRate: z.number().nullable(),
  message: z.string().nullable(),
  createdAt: z.string().datetime(),
  respondedAt: z.string().datetime().nullable(),
  contact: Contact.optional(),
  feePaidAt: z.string().datetime().nullable().optional().openapi({ description: "Ground-fee share: when the organiser ticked it as received. Shown to the organiser and the player." }),
};
const ApplicantItem = z
  .object({ ...Base, player: z.object({ id: z.string(), name: z.string(), avatarUrl: z.string().nullable(), rating: z.object({ average: z.number(), count: z.number() }), noShowCount: z.number(), verifiedBadge: z.boolean(), sports: z.array(z.unknown()), reliability: z.record(z.string(), z.unknown()).openapi({ description: "Same shape as PlayerCard.reliability." }), availableToday: z.boolean() }).nullable(), attendance: z.enum(["ATTENDED", "NO_SHOW"]).nullable().openapi({ description: "Marked by the organiser after the game." }) })
  .openapi("Applicant");
const MyApplicationItem = z.object({ ...Base, request: z.record(z.string(), z.unknown()).openapi({ description: "Same shape as a request (see PlayerRequest)." }) }).openapi("MyApplication");

const T = "Applications";
registerRoute({ method: "post", path: "/requests/{requestId}/applications", tag: T, summary: "Apply to a request", description: "Needs a player profile with the request's sport. A withdrawn application can be re-submitted; a rejected one can't. The poster is notified.", auth: true, params: requestIdParams, body: applyBody, response: ApplicantItem, status: 201, errors: [403, 404, 409, 422] });
registerRoute({ method: "get", path: "/requests/{requestId}/applications", tag: T, summary: "Applicants of my request (poster only)", auth: true, params: requestIdParams, query: applicantsQuery, response: z.array(ApplicantItem), errors: [403, 404, 422] });
registerRoute({ method: "get", path: "/applications/mine", tag: T, summary: "My applications", auth: true, query: myApplicationsQuery, response: z.array(MyApplicationItem), errors: [422] });
registerRoute({ method: "post", path: "/applications/{id}/accept", tag: T, summary: "Accept an applicant (poster only)", description: "Atomic: the request becomes FILLED when `playersNeeded` is reached. Notifies the player. Accepting twice is a no-op.", auth: true, params: applicationParams, response: ApplicantItem, errors: [403, 404, 409] });
registerRoute({ method: "post", path: "/applications/{id}/reject", tag: T, summary: "Reject an applicant (poster only)", auth: true, params: applicationParams, response: ApplicantItem, errors: [403, 404, 409] });
registerRoute({ method: "put", path: "/applications/{id}/fee-paid", tag: T, summary: "Tick or untick a player's ground-fee share (poster only)", description: "Only for an accepted player of a match that has a ground fee. The app never moves money: this is the organiser's own record.", auth: true, params: applicationParams, body: feePaidBody, response: ApplicantItem, errors: [403, 404, 409] });
registerRoute({ method: "post", path: "/applications/{id}/withdraw", tag: T, summary: "Withdraw my application", description: "Pending or accepted. Withdrawing after acceptance frees the spot (a FILLED request re-opens) and notifies the poster.", auth: true, params: applicationParams, response: ApplicantItem, errors: [404, 409] });
