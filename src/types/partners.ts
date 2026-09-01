import { z } from "zod";
import { netIdSchema } from "./index.js";

export const partnerGroupMemberEntry = z.object({
  netId: netIdSchema,
  name: z.string().nullable(),
});

export type PartnerGroupMemberEntry = z.infer<typeof partnerGroupMemberEntry>;

export const partnerGroupEntry = z.object({
  id: z.string().min(1),
  labSection: z.string().min(1),
  periodIndex: z.number().int().min(0),
  createdBy: z.string().min(1),
  members: z.array(partnerGroupMemberEntry),
});

export type PartnerGroupEntry = z.infer<typeof partnerGroupEntry>;

export const partnersForPeriodResponse = z.object({
  periodIndex: z.number().int().min(0),
  // Every lab section with enabled students in the course, regardless of
  // whether it has any groups yet for this period - lets staff still see
  // (and regenerate/edit into existence) a section with zero groups.
  sections: z.array(z.string()),
  groups: z.array(partnerGroupEntry),
  // Enabled students in the course with a lab section who aren't in any
  // group yet for this period - a gap for staff to fill in.
  ungroupedNetIds: z.array(netIdSchema),
});

export type PartnersForPeriodResponse = z.infer<
  typeof partnersForPeriodResponse
>;

// Full replacement of one section's groups for a period - simpler to reason
// about (and validate) than a partial add/remove/move patch.
export const putSectionGroupsBodySchema = z.object({
  labSection: z.string().min(1),
  groups: z
    .array(z.array(netIdSchema).min(2, "A group needs at least 2 members."))
    .min(1, "You must specify at least one group."),
});

export type PutSectionGroupsBody = z.infer<typeof putSectionGroupsBodySchema>;

export const regenerateSectionBodySchema = z.object({
  labSection: z.string().min(1),
});

export type RegenerateSectionBody = z.infer<typeof regenerateSectionBodySchema>;

export const myPartnerGroupResponse = z.object({
  periodIndex: z.number().int().min(0),
  labSection: z.string().nullable(),
  group: z
    .object({
      id: z.string().min(1),
      members: z.array(partnerGroupMemberEntry),
    })
    .nullable(),
});

export type MyPartnerGroupResponse = z.infer<typeof myPartnerGroupResponse>;
