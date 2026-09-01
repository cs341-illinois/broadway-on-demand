import { z } from "zod";
import { netIdSchema } from "./index.js";
import { PARTNER_MAX_ROUNDS } from "../constants.js";

export const partnerGroupMemberEntry = z.object({
  netId: netIdSchema,
  name: z.string().nullable(),
});

export type PartnerGroupMemberEntry = z.infer<typeof partnerGroupMemberEntry>;

export const partnerGroupEntry = z.object({
  id: z.string().min(1),
  labSection: z.string().min(1),
  // Not capped at PARTNER_MAX_ROUNDS since history endpoints reuse this shape
  // and must be able to display groups outside the current round window.
  roundNumber: z.number().int().min(1),
  createdBy: z.string().min(1),
  createdAt: z.string(),
  archivedAt: z.string().nullable(),
  archivedBy: z.string().nullable(),
  members: z.array(partnerGroupMemberEntry),
});

export type PartnerGroupEntry = z.infer<typeof partnerGroupEntry>;

export const partnersForRoundResponse = z.object({
  roundNumber: z.number().int().min(1).max(PARTNER_MAX_ROUNDS),
  // Every lab section with enabled students in the course, regardless of
  // whether it has any active groups yet for this round - lets staff still
  // see (and generate/regenerate/edit into existence) a section with none.
  sections: z.array(z.string()),
  groups: z.array(partnerGroupEntry),
  // Enabled students in the course with a lab section who aren't in any
  // active group yet for this round - a gap for staff to fill in.
  ungroupedNetIds: z.array(netIdSchema),
});

export type PartnersForRoundResponse = z.infer<typeof partnersForRoundResponse>;

// Full replacement of one section's active groups for a round, rather than a
// partial add/remove/move patch.
export const putSectionGroupsBodySchema = z.object({
  groups: z
    .array(z.array(netIdSchema).min(2, "A group needs at least 2 members."))
    .min(1, "You must specify at least one group."),
});

export type PutSectionGroupsBody = z.infer<typeof putSectionGroupsBodySchema>;

export const sectionRoundHistoryResponse = z.array(partnerGroupEntry);

export const studentPartnerHistoryResponse = z.array(partnerGroupEntry);

export const myPartnerGroupResponse = z.object({
  labSection: z.string().nullable(),
  rounds: z.array(
    z.object({
      roundNumber: z.number().int().min(1).max(PARTNER_MAX_ROUNDS),
      group: z
        .object({
          id: z.string().min(1),
          members: z.array(partnerGroupMemberEntry),
        })
        .nullable(),
    }),
  ),
});

export type MyPartnerGroupResponse = z.infer<typeof myPartnerGroupResponse>;
