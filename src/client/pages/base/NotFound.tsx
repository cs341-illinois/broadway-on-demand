import AppNavbar from "../../components/Navbar";
import { Container, Card } from "react-bootstrap";

export default function NotFoundPage() {
  const data = JSON.parse(window.sessionStorage.getItem("courseInfo") || "{}");
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <AppNavbar title={data.courseName} />
      <Container className="d-flex justify-content-center align-items-center flex-grow-1">
        <Card className="p-4">
          <Card.Body>
            <h4 className="card-title">Page Not Found</h4>
          </Card.Body>
        </Card>
      </Container>
    </div>
  );
}
