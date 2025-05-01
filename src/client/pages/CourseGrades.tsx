import { useState, useEffect, useTransition } from "react";
import AppNavbar from "../components/Navbar";
import {
  Container,
  Card,
  Button,
  Spinner,
  Row,
  Col,
  CardBody,
  CardGroup,
  ButtonToolbar,
  CardTitle,
  Tabs,
  Tab,
} from "react-bootstrap";
import { useAuth } from "../contexts/AuthContext";
import { formulateUrl, getCourseRoles } from "../utils";
import { useNavigate, useParams } from "react-router-dom";

async function getCourseData(courseId: string) {
  const response = await fetch(formulateUrl(`api/v1/courses/${courseId}`));
  return await response.json();
}

export default function GradesPage() {
  const { user } = useAuth();
  const { courseId } = useParams();
  const navigate = useNavigate();
  const [courseData, setCourseData] = useState<Record<string, any> | null>(
    null,
  );

  if (!courseId || getCourseRoles(courseId, user!.roles).length === 0) {
    navigate(formulateUrl("dashboard"));
    return null;
  }
  useEffect(() => {
    (async () => {
      const data = await getCourseData(courseId);
      setCourseData(data);
    })();
  }, []);
  const courseRoles = getCourseRoles(courseId, user!.roles);
  if (!courseData) {
    return (
      <div
        style={{ height: "100vh", display: "flex", flexDirection: "column" }}
      >
        <AppNavbar />
        <Container>
          <Spinner />
        </Container>
      </div>
    );
  }
  return (
    <>
      <AppNavbar />
      <div
        style={{ height: "100vh", display: "flex", flexDirection: "column" }}
      >
        <Container className="pt-2">
          <h1>{courseData.name}</h1>
          <h2>Grades</h2>
          <Tabs
            defaultActiveKey="all"
            id="uncontrolled-tab-example"
            className="mb-3"
          >
            <Tab eventKey="all" title="All">
              Tab content for Home
            </Tab>
            <Tab eventKey="labs" title="Profile">
              Tab content for Profile
            </Tab>
            <Tab eventKey="contact" title="Contact" disabled>
              Tab content for Contact
            </Tab>
          </Tabs>
        </Container>
      </div>
    </>
  );
}
