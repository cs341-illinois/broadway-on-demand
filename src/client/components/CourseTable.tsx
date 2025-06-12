import { Anchor } from "react-bootstrap";
import { FullRoleEntry } from "../../types/index";
import { formulateUrl, getCourseInfo } from "../utils";
import { useAuth } from "../contexts/AuthContext";
import { useNavigate } from "react-router-dom";

export const CourseRolesTable = ({ roles }: { roles: FullRoleEntry[] }) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  if (!user) {
    return null;
  }
  const navigateAndSetCurrentRole = (courseId: string) => {
    const data = getCourseInfo(user, courseId);
    window.sessionStorage.setItem("courseInfo", JSON.stringify(data));
    navigate(formulateUrl(`dashboard/${courseId}`));
  };
  return (
    <>
      <h1 className="pt-4">Select Course</h1>
      <ul>
        {roles.map((course) => (
          <li key={course.courseId}>
            <td>
              <Anchor
                onClick={() => {
                  navigateAndSetCurrentRole(course.courseId);
                }}
              >
                {course.courseName}
              </Anchor>
            </td>
          </li>
        ))}
      </ul>
    </>
  );
};
