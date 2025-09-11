import { getGradingEligibility } from "../functions/assignment.js";
import { PrismaClient } from "../generated/prisma/client.js";
import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) {
    throw new Error(
        "Failed to find DATABASE_URL environment variable to connect to database!",
    );
}

const courseId = process.argv[2];
const assignmentId = process.argv[3];
const netId = process.argv[4];

if (!courseId || !assignmentId || !netId) {
    console.error('Error: Please provide course ID, assignment ID, and a NetID.');
    console.log('Usage: npx tsx src/scripts/checkStudentRunEligibility.ts <courseId> <assignmentId> <netId>');
    process.exit(1);
}

const client = new PrismaClient();
await client.$transaction(async (tx) => {
    const { courseTimezone } = await tx.course.findFirstOrThrow({
        where: {
            id: courseId
        },
        select: {
            courseTimezone: true
        }
    })
    console.log(await getGradingEligibility({
        tx,
        courseId,
        assignmentId,
        netId,
        courseTimezone
    }))
})