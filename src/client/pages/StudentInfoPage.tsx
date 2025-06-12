import { useState, useEffect } from "react";
import AppNavbar from "../components/Navbar";
import {
  Badge,
  Col,
  Container,
  Row,
  Spinner,
  Form,
  InputGroup,
  Table,
} from "react-bootstrap"; // Import InputGroup
import { useAuth } from "../contexts/AuthContext";
import {
  attemptFormatEnum,
  dateTimeFormatString,
  formulateUrl,
  getCourseInfo,
  getCourseRoles,
  getTimeZoneName,
  setCourseInfoSessionStorage,
} from "../utils";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useAlert } from "../contexts/AlertContext";
import { StudentInfoResponse } from "../../types/studentInfo";
import { GradesForm, UserGradeTable } from "../components/UserGradeTable";
import useDebounce from "../hooks/useDebounce";
import moment from "moment-timezone";
import { FullRoleEntry } from "../../types/index";
import { LoadingScreen } from "../components/Loading";

export default function StudentInfoPage() {
  const { user } = useAuth();
  const { courseId } = useParams();
  const navigate = useNavigate();
  const { showAlert } = useAlert();
  const [searchParams, setSearchParams] = useSearchParams();
  const [courseInfo, setCourseInfo] = useState<FullRoleEntry | null>(null);

  // State for the immediate input value
  const [inputNetId, setInputNetId] = useState<string>("");
  // Debounced value of the inputNetId
  const debouncedNetId = useDebounce(inputNetId, 300);

  const [studentInfo, setStudentInfo] = useState<StudentInfoResponse | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState<boolean>(false); // Add loading state

  const courseRoles = getCourseRoles(courseId!, user!.roles);
  const isAdmin = courseRoles.includes("ADMIN");

  useEffect(() => {
    const netIdParam = searchParams.get("netId");
    if (netIdParam) {
      setInputNetId(netIdParam);
    }
  }, [searchParams]);
  async function getStudentInfo(courseId: string, netId: string) {
    if (netId) {
      setIsLoading(true);
      setStudentInfo(null);
    } else {
      setStudentInfo(null);
      setIsLoading(false);
      return null;
    }

    const response = await fetch(
      formulateUrl(`api/v1/studentInfo/${courseId}/user/${netId}`),
    );
    setIsLoading(false);

    if (!response.ok) {
      return null;
    }
    return (await response.json()) as StudentInfoResponse;
  }

  async function submitGradeChange(data: GradesForm, justification: string) {
    if (!studentInfo) {
      showAlert("Cannot submit grade changes: No student selected.", "warning");
      return;
    }

    const response = await fetch(
      formulateUrl(`api/v1/grades/${courseId}/user/${studentInfo.meta.netId}`),
      {
        // Use the netId from loaded studentInfo
        credentials: "include",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: data, justification }),
      },
    );
    if (!response.ok) {
      showAlert(
        `Failed to submit grade changes: ${response.statusText}`,
        "danger",
      );
      throw new Error(`Failed to submit user data: ${response.statusText}`);
    }
    showAlert("Grade changes submitted successfully!", "success");
    const updatedInfo = await getStudentInfo(courseId!, studentInfo.meta.netId);
    if (updatedInfo) {
      setStudentInfo(updatedInfo);
    }
  }

  useEffect(() => {
    if (
      !courseId ||
      getCourseRoles(courseId, user!.roles).length === 0 ||
      !(
        getCourseRoles(courseId, user!.roles).includes("STAFF") ||
        getCourseRoles(courseId, user!.roles).includes("ADMIN")
      )
    ) {
      navigate(formulateUrl("dashboard"));
    }
    if (user && courseId) {
      const courseInfoMeta = getCourseInfo(user, courseId)!;
      setCourseInfo(getCourseInfo(user, courseId));
      setCourseInfoSessionStorage(getCourseInfo(user, courseId)!);
      document.title = `Student Info | ${courseInfoMeta?.courseName}`;
    }
  }, [courseId, user, navigate]);

  useEffect(() => {
    (async () => {
      if (
        debouncedNetId &&
        (getCourseRoles(courseId!, user!.roles).includes("STAFF") ||
          getCourseRoles(courseId!, user!.roles).includes("ADMIN"))
      ) {
        const info = await getStudentInfo(courseId!, debouncedNetId);
        setStudentInfo(info);
        setSearchParams((prevSearchParams) => {
          const newSearchParams = new URLSearchParams(prevSearchParams);
          newSearchParams.set("netId", debouncedNetId);
          return newSearchParams.toString();
        });
      } else if (!debouncedNetId) {
        setStudentInfo(null);
        setIsLoading(false);
      }
    })();
  }, [debouncedNetId, courseId, user]);

  if (!courseInfo) {
    return <LoadingScreen message="Loading user data..." />;
  }
  return (
    <>
      <AppNavbar
        title={courseInfo?.courseName}
        breadcrumb={{
          items: [
            {
              label: "Course Home",
              href: formulateUrl(`dashboard/${courseId}`),
            },
            {
              label: "View Student",
              href: formulateUrl(`dashboard/${courseId}/studentInfo`),
            },
            ...(studentInfo && studentInfo.meta.name
              ? [{ label: studentInfo.meta.name }]
              : []),
          ],
        }}
      />
      <div
        style={{ height: "100vh", display: "flex", flexDirection: "column" }}
      >
        <Container className="p-2">
          <Row className="mb-3">
            <Col xs={12} md={6}>
              <h2>Enter NetID</h2>
              <p className="text-muted">
                To manage assignment grades,{" "}
                <a
                  href={formulateUrl(`dashboard/${courseId}/assignmentGrades`)}
                >
                  click here
                </a>
                .
              </p>
              <Form.Group controlId="netIdInput">
                <InputGroup>
                  {" "}
                  {/* Use InputGroup here */}
                  <Form.Control
                    type="text"
                    placeholder="NetID"
                    value={inputNetId}
                    minLength={3}
                    maxLength={8}
                    onChange={(e) =>
                      setInputNetId(e.target.value.replaceAll(" ", ""))
                    }
                  />
                  {isLoading && (
                    <InputGroup.Text>
                      <Spinner animation="border" size="sm" />
                      <span className="visually-hidden">Loading...</span>
                    </InputGroup.Text>
                  )}
                </InputGroup>
              </Form.Group>
            </Col>
          </Row>
          {!isLoading && !studentInfo && debouncedNetId && (
            <div className="text-center text-muted">
              No student found for NetID "{debouncedNetId}" in this course.
            </div>
          )}

          {!isLoading && studentInfo && (
            <>
              <h2>
                Manage <code>{studentInfo.meta.name}</code>{" "}
                <h4>
                  <Badge>{studentInfo.meta.role}</Badge>
                  {!studentInfo.meta.enabled && (
                    <Badge className="ms-2" bg="danger">
                      DISABLED
                    </Badge>
                  )}
                </h4>
              </h2>
              <p className="text-muted">
                All timestamps shown in your local timezone (
                {getTimeZoneName()}).
              </p>
              <Row>
                <Col xs={12} md={8}>
                  <h3>Grades</h3>
                </Col>
              </Row>
              <UserGradeTable
                grades={studentInfo.grades}
                category="all"
                setGradeChanges={
                  isAdmin && studentInfo.meta.enabled
                    ? submitGradeChange
                    : undefined
                }
              />
              <Row>
                <Col xs={12} md={8}>
                  <h3>Extensions</h3>
                </Col>
                {studentInfo.extensions.length === 0 && (
                  <p className="text-muted">No extensions for this user.</p>
                )}
                {studentInfo.extensions.length > 0 && (
                  <Table>
                    <thead>
                      <tr>
                        <th>Assignment</th>
                        <th>Open At</th>
                        <th>Close At</th>
                        <th>Created By</th>
                        <th>Extension Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {studentInfo.extensions.map((x) => (
                        <tr
                          key={`${x.assignmentId} - ${x.openAt} - ${x.closeAt}`}
                        >
                          <td>{x.name}</td>
                          <td>
                            {moment(x.openAt).format(dateTimeFormatString)}
                          </td>
                          <td>
                            {moment(x.closeAt).format(dateTimeFormatString)}
                          </td>
                          <td>{x.createdBy}</td>
                          <td>{attemptFormatEnum(x.initiator)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Row>
            </>
          )}
        </Container>
      </div>
    </>
  );
}
