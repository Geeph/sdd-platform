import XCTest
@testable import {{component_id}}

final class ContentViewTests: XCTestCase {
    func testContentViewInstantiates() {
        let view = ContentView()
        XCTAssertNotNil(view)
    }
}
