Pod::Spec.new do |s|
  s.name           = 'GrocerySiri'
  s.version        = '1.0.0'
  s.summary        = 'App Group bridge for the Siri add-item integration.'
  s.description    = 'Reads/writes the shared App Group container that the ' \
                     'Grocery List Siri App Intent also uses.'
  s.author         = 'Josh Approved'
  s.homepage       = 'https://joshapproved.com'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
