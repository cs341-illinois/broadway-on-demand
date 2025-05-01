import { Anchor, Table } from "react-bootstrap";
import { FullRoleEntry } from "../../types/index";
import { formulateUrl } from "../utils";

export const CourseRolesTable = ({ roles }: { roles: FullRoleEntry[] }) => {
  return (
    <>
      <h1 className="pt-4">Select Course</h1>
      <ul>
        {roles.map((course) => (
          <li key={course.courseId}>
            <td>
              <Anchor href={formulateUrl(`dashboard/${course.courseId}`)}>
                {course.courseName}
              </Anchor>
            </td>
          </li>
        ))}
      </ul>
    </>
  );
};
