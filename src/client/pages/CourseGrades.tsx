import { useEffect, Suspense, useMemo } from "react";
import { Container, Tabs, Tab } from "react-bootstrap";
import { useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../contexts/AuthContext";
import {
  createResource,
  formulateUrl,
  getCourseInfo,
  getCourseRoles,
  Resource,
  setCourseInfoSessionStorage,
} from "../utils";
import AppNavbar from "../components/Navbar";
import { UserGradeTable } from "../components/UserGradeTable";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { LoadingScreen } from "../components/Loading";

import { UserGradesResponse } from "../../types/grades";
import { CategoryLabels } from "../../types/assignment";
import { Category } from "../enums";
import { useAlert } from "../contexts/AlertContext";

interface CourseDetails {
  name: string;
  [key: string]: any;
}

interface GradesPageData {
  courseDetails: CourseDetails;
  grades: UserGradesResponse;
}

async function fetchCourseDetailsInternal(
  courseId: string,
): Promise<CourseDetails> {
  if (!courseId) {
    throw new Error("Course ID is missing for fetching course details.");
  }
  const response = await fetch(formulateUrl(`api/v1/courses/${courseId}`));
  if (!response.ok) {
    let errorMessage = `Failed to fetch course details. Status: ${response.status}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorData.detail || errorMessage;
    } catch (e) {}
    throw new Error(errorMessage);
  }
  return (await response.json()) as CourseDetails;
}

async function fetchGradesInternal(
  courseId: string,
): Promise<UserGradesResponse> {
  if (!courseId) {
    throw new Error("Course ID is missing for fetching grades.");
  }
  const response = await fetch(formulateUrl(`api/v1/grades/${courseId}/me`));
  if (!response.ok) {
    let errorMessage = `Failed to fetch grades. Status: ${response.status}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorData.detail || errorMessage;
    } catch (e) {}
    throw new Error(errorMessage);
  }
  return (await response.json()) as UserGradesResponse;
}

async function getGradesPageData(courseId: string): Promise<GradesPageData> {
  const [courseDetails, grades] = await Promise.all([
    fetchCourseDetailsInternal(courseId),
    fetchGradesInternal(courseId),
  ]);
  return { courseDetails, grades };
}

interface GradesContentProps {
  gradesPageResource: Resource<GradesPageData>;
  courseId: string;
}

function GradesContent({ gradesPageResource, courseId }: GradesContentProps) {
  const { courseDetails, grades } = gradesPageResource.read();

  return (
    <>
      <AppNavbar
        title={courseDetails.name}
        breadcrumb={{
          items: [
            {
              label: "Course Home",
              href: formulateUrl(`dashboard/${courseId}`),
            },
            { label: "View Grades" },
          ],
        }}
      />
      <Container className="pt-2 flex-grow-1">
        <h2>Grades</h2>
        <Tabs
          defaultActiveKey="all-tab"
          id="grades-tabs"
          transition={false}
          className="mb-3"
        >
          {["all", ...new Set(grades.map((x) => x.category))].map(
            (category) => (
              <Tab
                eventKey={`${category}-tab`}
                title={
                  category === "all"
                    ? "All"
                    : CategoryLabels[category as Category] || category
                }
                key={`${category}-tab`}
              >
                <UserGradeTable grades={grades} category={category} courseId={courseId} />
              </Tab>
            ),
          )}
        </Tabs>
      </Container>
    </>
  );
}

export default function GradesPage(): JSX.Element {
  const { user } = useAuth();
  const { courseId = "" } = useParams<{ courseId?: string }>();
  const navigate = useNavigate();
  const { showAlert } = useAlert();

  const courseRoles = useMemo(() => {
    if (!user?.roles) return [];
    return getCourseRoles(courseId, user.roles);
  }, [courseId, user]);

  useEffect(() => {
    if (!user) return;

    if (!courseId || courseRoles.length === 0) {
      showAlert(
        "The specified course does not exist or you do not have access.",
        "danger",
      );
      console.warn("Redirecting: Course ID missing or no roles for course.");
      navigate(formulateUrl("dashboard"));
    }
    const courseInfo = getCourseInfo(user, courseId)!;
    setCourseInfoSessionStorage(courseInfo);
    document.title = `Grades | ${courseInfo.courseName}`;
  }, [courseId, user, courseRoles, navigate]);

  const gradesPageResource = useMemo<Resource<GradesPageData>>(() => {
    return createResource<GradesPageData>(() => getGradesPageData(courseId));
  }, [courseId, user?.id]);

  return (
    <div
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      <ErrorBoundary>
        <Suspense fallback={<LoadingScreen />}>
          <GradesContent
            gradesPageResource={gradesPageResource}
            courseId={courseId}
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
