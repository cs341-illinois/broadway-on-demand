import { Container, Spinner } from "react-bootstrap";
import AppNavbar from "./Navbar";

export function LoadingScreen({ message }: { message?: string }) {
  const data = JSON.parse(window.sessionStorage.getItem("courseInfo") || "{}");
  return (
    <>
      <AppNavbar title={data.courseName} />
      <Container className="pt-3 d-flex justify-content-center align-items-center flex-grow-1">
        <Spinner
          animation="border"
          role="status"
          className="me-3"
          style={{ width: "3rem", height: "3rem" }}
        ></Spinner>
        <span>{message || "Loading..."}</span>
      </Container>
    </>
  );
}
