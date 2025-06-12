import { useEffect } from "react";
import AppNavbar from "../components/Navbar";
import { Container } from "react-bootstrap";
import { useAuth } from "../contexts/AuthContext";
import { CourseRolesTable } from "../components/CourseTable";
import { formulateUrl, getCourseInfo } from "../utils";
import { useNavigate } from "react-router-dom";

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (user?.roles.length === 1) {
      const courseId = user.roles[0].courseId;
      const courseInfo = getCourseInfo(user, courseId);
      window.sessionStorage.setItem("courseInfo", JSON.stringify(courseInfo));
      navigate(formulateUrl(`dashboard/${courseId}`));
    } else {
      window.sessionStorage.removeItem("courseInfo");
    }
  }, [user]);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <AppNavbar />
      <Container>
        <CourseRolesTable roles={user!.roles} />
      </Container>
    </div>
  );
}
